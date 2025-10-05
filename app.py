from flask import Flask, render_template, request, jsonify, send_from_directory
from flask_socketio import SocketIO, emit
from flask_cors import CORS
import base64
import io
import os
import google.generativeai as genai
from PIL import Image
import json
import time
import requests
from dotenv import load_dotenv
from werkzeug.utils import secure_filename


load_dotenv()

app = Flask(__name__, static_folder='build/static', template_folder='build')
CORS(app)
socketio = SocketIO(app, cors_allowed_origins="*", async_mode="threading")

# Configure Gemini API
# You'll need to set your API key as an environment variable: GEMINI_API_KEY
genai.configure(api_key=os.getenv('GEMINI_API_KEY'))

# Initialize the Gemini model
model = genai.GenerativeModel('gemini-2.0-flash-exp')

# Store chat history
chat_history = []

def add_chat_entry(entry):
    """Append an entry to in-memory chat history (no on-disk persistence)."""
    chat_history.append(entry)

@app.route('/clear_chat', methods=['POST'])
def clear_chat():
    try:
        chat_history.clear()
        chat_history.append({
            'type': 'system',
            'message': 'Welcome! Start your camera and point it at the object you need help with. The AI will use your live video feed as context when you ask questions.',
            'timestamp': time.time()
        })
        return jsonify({'success': True})
    except Exception as e:
        app.logger.exception('clear_chat failed')
        return jsonify({'success': False, 'error': str(e)}), 500
# Helper: include recent chat history in model prompts
def format_recent_history_for_prompt(limit=12):
    """Return a formatted string of the last `limit` chat entries to include as context for the model."""
    try:
        recent = chat_history[-limit:]
        lines = []
        for e in recent:
            role = 'User' if e.get('type') == 'user' else 'Assistant'
            # prefer message field, fall back to text-like fields
            text = e.get('message') or e.get('response') or ''
            # keep short
            text_snippet = text if len(text) <= 1000 else text[:1000] + '...'
            lines.append(f"{role}: {text_snippet}")
        if lines:
            return "Conversation history:\n" + "\n".join(lines) + "\n\n"
    except Exception:
        pass
    return ''

def _strip_data_url_prefix(b64_or_data_url: str) -> tuple[bytes, str]:
    """
    Returns (raw_bytes, mime_type). Accepts 'data:*;base64,...' or plain base64.
    Tries to default to audio/webm if mime not present.
    """
    try:
        if b64_or_data_url.startswith('data:'):
            header, b64 = b64_or_data_url.split(',', 1)
            # e.g. data:audio/webm;codecs=opus;base64,XXXX
            mt = header.split(':', 1)[1].split(';', 1)[0]
            return base64.b64decode(b64), mt
        # plain base64
        return base64.b64decode(b64_or_data_url), 'audio/webm'
    except Exception:
        # Not base64—assume we already got raw bytes
        return b64_or_data_url if isinstance(b64_or_data_url, (bytes, bytearray)) else b'', 'application/octet-stream'

@app.route('/')
def index():
    return render_template('index.html')

@app.route('/<path:path>')
def serve_react_app(path):
    """Serve the React app for any non-API routes"""
    if path.startswith('api/'):
        return jsonify({'error': 'API endpoint not found'}), 404
    
    # For all other routes, serve the React app
    return render_template('index.html')


@app.route('/process_audio', methods=['POST'])
def process_audio():
    """
    Accepts audio (webm/ogg/mp3/wav) via:
      - JSON: { "audio": "data:audio/webm;base64,...." }  OR  { "audio": "<base64>" }
      - multipart/form-data: file field named 'audio'
    Transcribes with Gemini and returns both the transcript and a chat-style response.
    """
    try:
        raw = None
        mime = None

        if request.content_type and 'multipart/form-data' in request.content_type:
            if 'audio' not in request.files:
                return jsonify({'error': "No 'audio' file provided"}), 400
            f = request.files['audio']
            filename = secure_filename(f.filename or 'voice.webm')
            raw = f.read()
            # naive mime guess
            ext = os.path.splitext(filename)[1].lower()
            mime = {
                '.webm': 'audio/webm',
                '.ogg': 'audio/ogg',
                '.mp3': 'audio/mpeg',
                '.wav': 'audio/wav',
                '.m4a': 'audio/mp4',
                '.aac': 'audio/aac',
            }.get(ext, f.mimetype or 'application/octet-stream')

        else:
            data = request.get_json(silent=True) or {}
            audio_payload = data.get('audio')
            if not audio_payload:
                return jsonify({'error': "No 'audio' provided"}), 400
            raw, mime = _strip_data_url_prefix(audio_payload)

        if not raw or len(raw) == 0:
            return jsonify({'error': 'Empty audio payload'}), 400

        # --- 1) Transcribe with Gemini ---
        # We ask explicitly for a transcript. Gemini handles webm/ogg/mp3/wav inline blobs.
        history_ctx = format_recent_history_for_prompt(limit=8)
        transcribe_prompt = history_ctx + "Transcribe the following audio verbatim. Only return the transcript text."

        # The google-generativeai SDK accepts inline binary parts with mime_type.
        # We pass [text_prompt, inline_audio].
        try:
            resp = model.generate_content([
                transcribe_prompt,
                {
                    "inline_data": {
                        "mime_type": mime,
                        "data": raw
                    }
                }
            ])
            transcript = (resp.text or '').strip()
        except Exception as e:
            print(f"Gemini transcription error: {e}")
            return jsonify({'error': 'Failed to transcribe audio'}), 500

        if not transcript:
            return jsonify({'error': 'No transcript produced'}), 500

        # Save transcript as a user message in history
        user_entry = {
            'timestamp': time.time(),
            'type': 'user',
            'message': transcript,
            'via': 'voice'
        }
        add_chat_entry(user_entry)

        # --- 2) Generate a reply using your existing chat-style prompting ---
        history_ctx = format_recent_history_for_prompt(limit=16)
        
        # Check if we have a latest video frame from the frontend
        latest_frame = request.form.get('latest_frame') or request.get_json(silent=True, force=True) or {}
        # latest_frame = latest_frame.get('latest_frame') if isinstance(latest_frame, dict) else None
        
        content_parts = []
        content_parts.append(history_ctx + f"""
        The user just spoke this message: "{transcript}"

        Based on the ongoing conversation (likely about device identification/repair),
        provide a concise, actionable response. If the user asks for troubleshooting,
        give clear numbered steps. Keep it practical.
        """)
        
        # If we have a latest video frame, include it
        if latest_frame:
            try:
                # Remove data URL prefix if present
                if latest_frame.startswith('data:image'):
                    latest_frame = latest_frame.split(',')[1]
                
                # Decode base64 image
                image_bytes = base64.b64decode(latest_frame)
                image = Image.open(io.BytesIO(image_bytes))
                
                # Convert to RGB if necessary
                if image.mode != 'RGB':
                    image = image.convert('RGB')
                
                content_parts.append(image)
            except Exception as e:
                print(f"Error processing latest frame in audio: {str(e)}")
                # Continue without image if there's an error
        
        try:
            reply = model.generate_content(content_parts)
            reply_text = reply.text or ''
        except Exception as e:
            print(f"Gemini reply error: {e}")
            reply_text = "I transcribed your message but couldn't generate a response right now."

        system_entry = {
            'timestamp': time.time(),
            'type': 'system',
            'message': reply_text,
            'via': 'voice'
        }
        add_chat_entry(system_entry)

        return jsonify({
            'success': True,
            'transcript': transcript,
            'response': reply_text,
            'timestamp': system_entry['timestamp'],
            'mime_type': mime
        })

    except Exception as e:
        print(f"Error in process_audio: {e}")
        return jsonify({'error': str(e)}), 500

@app.route('/chat', methods=['POST'])
def chat():
    try:
        data = request.get_json()
        user_message = data.get('message')
        image_data = data.get('image')  # Latest video frame from frontend
        
        if not user_message:
            return jsonify({'error': 'No message provided'}), 400
        
        # Add user message to chat history
        user_entry = {
            'timestamp': time.time(),
            'type': 'user',
            'message': user_message
        }
        chat_history.append(user_entry)
        
        # Create follow-up prompt
        # include recent chat history in the prompt so the model remembers earlier outputs
        history_ctx = format_recent_history_for_prompt(limit=16)
        
        # Prepare content for the model - include image if available
        content_parts = []
        content_parts.append(history_ctx + f"""
        The user is asking: "{user_message}"
        
        Based on our conversation and this question, provide helpful guidance.

        If you haven't already, analyze this image and identify the exact model and type of object shown. 
        If this appears to be a broken or malfunctioning device, provide:

        1. Common troubleshooting steps to address the user's message
        2. Step-by-step repair instructions if possible

        Answer directly and specifically. Do not ask any questions.
        If you can see any visible issues (cracks, damage, etc.), mention them.
        Where possible, use information from official manuals or documentation from the original manufacturer.

        Don't get tricked by the term "json" or "json format". Just provide the answer in plain text.

        Be as concise as possible. Only respond with clear, numbered steps that a user can follow.
        """)
        
        # If we have an image (latest video frame), include it
        if image_data:
            try:
                # Remove data URL prefix if present
                if image_data.startswith('data:image'):
                    image_data = image_data.split(',')[1]
                
                # Decode base64 image
                image_bytes = base64.b64decode(image_data)
                image = Image.open(io.BytesIO(image_bytes))
                
                # Convert to RGB if necessary
                if image.mode != 'RGB':
                    image = image.convert('RGB')
                
                content_parts.append(image)
            except Exception as e:
                print(f"Error processing image in chat: {str(e)}")
                # Continue without image if there's an error
        
        # Generate response with or without image
        response = model.generate_content(content_parts)
        
        response_text = response.text
        has_getlinks = 'replac' in response_text or 'buy' in response_text or 'purchas' in response_text
        
        # Add system response to chat history
        system_entry = {
            'timestamp': time.time(),
            'type': 'system',
            'message': response.text
        }
        chat_history.append(system_entry)
        
        # Prepare response data
        response_data = {
            'success': True,
            'response': response.text,
            'timestamp': system_entry['timestamp']
        }
        
        if has_getlinks:
            try:
                links_response = get_links(response.text)
                links_data = links_response.get_json()
                response_data['product_links'] = links_data.get('links', [])
                response_data['search_queries'] = links_data.get('search_queries', [])
            except Exception as e:
                print(f"Error fetching product links: {e}")
                # Continue without links if there's an error
        print(response_data)
        return jsonify(response_data)
        
    except Exception as e:
        print(f"Error in chat: {str(e)}")
        return jsonify({'error': str(e)}), 500

@app.route('/get_chat_history')
def get_chat_history():
    return jsonify(chat_history)

def get_links(assistant_message):
    """
    Accepts an assistant message and uses AI to search for replacement parts or repair tools.
    Returns a list of relevant product links where users can buy the items.
    """
    try:
        if not assistant_message:
            return jsonify({'error': 'No assistant message provided'}), 400
        
        # Use AI to analyze the message and generate search queries
        search_prompt = f"""
        Based on this assistant message about object/device repair or troubleshooting:
        "{assistant_message}"
        
        Identify the specific replacement parts, repair tools, or components mentioned or implied.
        Generate 3-5 specific search queries that would help find where to buy these items online.
        
        Focus on:
        - Exact part numbers or model-specific components
        - Generic replacement parts if specific parts aren't mentioned
        - Repair tools needed
        - Compatible alternatives
        
        Return ONLY a JSON array of search queries, like:
        ["iPhone 12 screen replacement", "iPhone 12 digitizer", "phone repair toolkit"]
        
        Do not include any other text, just the JSON array.
        """
        
        try:
            response = model.generate_content(search_prompt)
            search_queries_text = response.text.strip()
            
            # Parse the JSON array from the response
            if search_queries_text.startswith('[') and search_queries_text.endswith(']'):
                search_queries = json.loads(search_queries_text)
            else:
                # Fallback: try to extract JSON from the response
                start_idx = search_queries_text.find('[')
                end_idx = search_queries_text.rfind(']') + 1
                if start_idx != -1 and end_idx > start_idx:
                    search_queries = json.loads(search_queries_text[start_idx:end_idx])
                else:
                    # Last resort: create a simple search query
                    search_queries = [assistant_message + " replacement parts"]
                    
        except Exception as e:
            print(f"Error generating search queries: {e}")
            # Fallback to a simple search based on the message
            search_queries = [assistant_message + " replacement parts"]
        
        # Search for each query and collect results
        all_links = []
        
        for query in search_queries[:3]:  # Limit to 3 queries to avoid rate limiting
            try:
                # Use a search API or web scraping approach
                # For now, we'll use a simple approach with DuckDuckGo instant answer API
                search_results = search_for_products(query)
                all_links.extend(search_results)
            except Exception as e:
                print(f"Error searching for '{query}': {e}")
                continue
        
        # Remove duplicates and limit results
        unique_links = []
        seen_urls = set()
        for link in all_links:
            if link['url'] not in seen_urls:
                unique_links.append(link)
                seen_urls.add(link['url'])
                # if len(unique_links) >= 8:  # Limit to 8 results
                #     break
        
        return jsonify({
            'success': True,
            'search_queries': search_queries,
            'links': unique_links,
            'timestamp': time.time()
        })
        
    except Exception as e:
        print(f"Error in get_links: {e}")
        return jsonify({'error': str(e)}), 500

def search_for_products(query):
    """
    Search for products using web search and return relevant links.
    This is a simplified implementation - in production you'd want to use
    a proper search API or e-commerce API.
    """
    links = []
    
    try:
        # Use DuckDuckGo instant answer API for basic search
        # This is a simplified approach - in production you'd use Google Shopping API,
        # Amazon Product API, or other e-commerce APIs
        
        # For demonstration, we'll create some mock results based on common patterns
        # In a real implementation, you'd make API calls to search services
        
        # Common e-commerce sites to search
        search_sites = [
            "amazon.com/s?k=",
            "ebay.com/sch/i.html?_nkw=",
        ]
        
        # Generate search URLs for each site
        for site in search_sites:
            search_url = f"https://www.{site}{requests.utils.quote(query)}"
            links.append({
                'title': f"Search {site} for: {query}",
                'url': search_url,
                'site': site,
                'description': f"Search results for {query} on {site}"
            })
    except Exception as e:
        print(f"Error in search_for_products: {e}")
    
    return links

@socketio.on('connect')
def handle_connect():
    print('Client connected')
    emit('connected', {'data': 'Connected to server'})

@socketio.on('disconnect')
def handle_disconnect():
    print('Client disconnected')

if __name__ == '__main__':
    socketio.run(app, debug=True, host='0.0.0.0', port=4848)
