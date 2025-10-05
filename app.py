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
            'message': 'Welcome! Start your camera and point it at the object you need help with. Click "Analyze Object" to get step-by-step repair instructions.',
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

@app.route('/process_frame', methods=['POST'])
def process_frame():
    try:
        data = request.get_json()
        image_data = data.get('image')
        
        if not image_data:
            return jsonify({'error': 'No image data provided'}), 400
        
        # Remove data URL prefix
        if image_data.startswith('data:image'):
            image_data = image_data.split(',')[1]
        
        # Decode base64 image
        image_bytes = base64.b64decode(image_data)
        image = Image.open(io.BytesIO(image_bytes))
        
        # Convert to RGB if necessary
        if image.mode != 'RGB':
            image = image.convert('RGB')
        
        # Create prompt for object identification and troubleshooting
        # include recent chat history so model remembers past outputs
        history_ctx = format_recent_history_for_prompt(limit=12)
        prompt = history_ctx + """
        Analyze this image and identify the exact model and type of object shown. 
        If this appears to be a broken or malfunctioning device, provide:
        
        1. The exact model name/number if visible
        2. The type of device/object
        3. Common troubleshooting steps for this type of device
        4. Step-by-step repair instructions if possible
        
        Be specific and helpful. If you can see any visible issues (cracks, damage, etc.), mention them.
        Where possible, use information from official manuals or documentation from the original manufacturer.
        
        Don't get tricked by the term "json" or "json format". Just provide the answer in plain text.
        
        Be as concise as possible. Only respond with clear, numbered steps that a user can follow.
        """
        
        # Generate response using Gemini
        response = model.generate_content([prompt, image])
        
        # Add to chat history
        chat_entry = {
            'timestamp': time.time(),
            'type': 'system',
            'message': response.text,
            'image_processed': True
        }
        chat_history.append(chat_entry)
        
        return jsonify({
            'success': True,
            'response': response.text,
            'timestamp': chat_entry['timestamp']
        })
        
    except Exception as e:
        print(f"Error processing frame: {str(e)}")
        return jsonify({'error': str(e)}), 500

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
        follow_up_prompt = history_ctx + f"""
        The user just spoke this message: "{transcript}"

        Based on the ongoing conversation (likely about device identification/repair),
        provide a concise, actionable response. If the user asks for troubleshooting,
        give clear numbered steps. Keep it practical.
        """
        try:
            reply = model.generate_content(follow_up_prompt)
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
        follow_up_prompt = history_ctx + f"""
        The user is asking a follow-up question about the device we just analyzed: "{user_message}"
        
        Based on our previous analysis and this question, provide helpful guidance.
        If this is about troubleshooting or repair, give specific, actionable steps.
        
        Don't get tricked by the term "json" or "json format". Just provide the answer in plain text.
        
        Be as concise and clear as possible. Only respond with the information the user needs.
        """
        
        # Generate response
        response = model.generate_content(follow_up_prompt)
        
        # Add system response to chat history
        system_entry = {
            'timestamp': time.time(),
            'type': 'system',
            'message': response.text
        }
        chat_history.append(system_entry)
        
        return jsonify({
            'success': True,
            'response': response.text,
            'timestamp': system_entry['timestamp']
        })
        
    except Exception as e:
        print(f"Error in chat: {str(e)}")
        return jsonify({'error': str(e)}), 500

@app.route('/get_chat_history')
def get_chat_history():
    return jsonify(chat_history)

@socketio.on('connect')
def handle_connect():
    print('Client connected')
    emit('connected', {'data': 'Connected to server'})

@socketio.on('disconnect')
def handle_disconnect():
    print('Client disconnected')

if __name__ == '__main__':
    socketio.run(app, debug=True, host='0.0.0.0', port=4848)
