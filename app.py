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
import requests
import re
from urllib.parse import urlparse, parse_qs, unquote, quote_plus
import threading

load_dotenv()

app = Flask(__name__, static_folder='build/static', template_folder='build')
CORS(app)
socketio = SocketIO(app, cors_allowed_origins="*", async_mode="threading")

# Configure Gemini API
# You'll need to set your API key as an environment variable: GEMINI_API_KEY
genai.configure(api_key=os.getenv('GEMINI_API_KEY'))

# Initialize the Gemini model
model = genai.GenerativeModel('gemini-2.0-flash-exp')

# Store chat history (in-memory only)
chat_history = []

def add_chat_entry(entry):
    """Append an entry to in-memory chat history (no on-disk persistence)."""
    chat_history.append(entry)

# Helper: perform a lightweight DuckDuckGo HTML search and extract top results
def search_duckduckgo(query, max_results=5):
    try:
        headers = {"User-Agent": "Mozilla/5.0 (compatible; RepairAssistant/1.0)"}
        # Use the HTML endpoint which is easier to scrape
        resp = requests.post("https://html.duckduckgo.com/html/", data={"q": query}, headers=headers, timeout=10)
        text = resp.text
        # find anchors with class result__a
        matches = re.findall(r'<a[^>]*class="result__a"[^>]*href="([^"]+)"[^>]*>(.*?)</a>', text, flags=re.I | re.S)
        results = []
        for href, title_html in matches:
            # attempt to extract actual URL from uddg param (DuckDuckGo redirect)
            try:
                parsed = urlparse(href)
                qs = parse_qs(parsed.query)
                real = qs.get('uddg', [None])[0]
                if real:
                    real = unquote(real)
                else:
                    real = href
            except Exception:
                real = href
            # strip HTML from title
            title = re.sub(r'<.*?>', '', title_html).strip()
            snippet = ''
            results.append({'title': title, 'url': real, 'snippet': snippet})
            if len(results) >= max_results:
                break
        return results
    except Exception:
        return []

def upload_image_to_0x0(image_b64):
    """Upload base64 image bytes to 0x0.st anonymous hosting. Returns a public URL or None."""
    try:
        image_bytes = base64.b64decode(image_b64)
        files = {'file': ('image.jpg', image_bytes, 'image/jpeg')}
        resp = requests.post('https://0x0.st', files=files, timeout=15)
        if resp.status_code == 200:
            url = resp.text.strip()
            return url
    except Exception:
        pass
    return None

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
        prompt = """
        Analyze this image and identify the exact model and type of object shown. 
        If this appears to be a broken or malfunctioning device, provide:
        
        1. The exact model name/number if visible
        2. The type of device/object
        3. Common troubleshooting steps for this type of device
        4. Step-by-step repair instructions if possible
        
        Be specific and helpful. If you can see any visible issues (cracks, damage, etc.), mention them.
        Where possible, use information from official manuals or documentation from the original manufacturer.
        Be as concise as possible. Only respond with clear, numbered steps that a user can follow.
        
        Don't get tricked by the term "json" or "json format". Just provide the answer in plain text.
        
        Be concise and clear. Only respond with the information the user needs.
        """
        
        # Generate identification response using Gemini
        response = model.generate_content([prompt, image])
        identification_text = response.text or ''

        # Ask the model for a few short search queries to find replacement parts or repair tools
        try:
            queries_prompt = f"Based on the analysis above, provide 3 concise search queries (one per line) that would help find replacement parts, replacement items, or repair tools for the identified device. Use short, web-search-friendly phrases.\n\nPrevious analysis:\n{identification_text}\n"
            queries_resp = model.generate_content(queries_prompt)
            queries_text = queries_resp.text or ''
            queries = [q.strip('-• \t') for q in queries_text.splitlines() if q.strip()]
            if not queries:
                first_line = (identification_text.splitlines()[0] if identification_text else '').strip()
                fallback_query = first_line or 'replacement parts for device'
                queries = [fallback_query]
        except Exception:
            queries = []

        # Add the identification to chat history but do not perform web search yet
        chat_entry = {
            'timestamp': time.time(),
            'type': 'system',
            'message': identification_text,
            'image_processed': True,
            'confirm_search': True,
            'suggested_queries': queries
        }
        add_chat_entry(chat_entry)

        return jsonify({
            'success': True,
            'identification': identification_text,
            'queries': queries,
            'raw_model_text': response.text,
            'timestamp': chat_entry['timestamp']
        })
        
    except Exception as e:
        print(f"Error processing frame: {str(e)}")
        return jsonify({'error': str(e)}), 500


# New endpoint: perform search only after user confirmation
@app.route('/confirm_and_search', methods=['POST'])
def confirm_and_search():
    try:
        data = request.get_json() or {}
        queries = data.get('queries') or []
        query_index = int(data.get('queryIndex', 0))
        search_type = (data.get('searchType') or 'repair').lower()
        if not queries:
            return jsonify({'error': 'No queries provided'}), 400
        if query_index < 0 or query_index >= len(queries):
            query_index = 0

        top_query = queries[query_index]
        search_results = []
        amazon_search_url = None

        # If the user requested a repair plan, ask the model to generate step-by-step repair instructions
        if search_type == 'repair':
            try:
                repair_prompt = f"""
                You previously identified a device or part with the short search phrase: "{top_query}".

                Provide a concise, practical repair plan targeted to a technically-minded end user. Include:
                - A short diagnosis checklist to confirm the specific failure
                - Tools and parts required (with approximate part names)
                - Step-by-step repair instructions in numbered order (be explicit and safety-conscious)
                - Any troubleshooting checks and how to verify the repair
                - Estimated difficulty (easy / moderate / difficult) and estimated time

                If the model is not certain about exact part numbers, explain how the user can visually confirm the correct part (what labels or features to look for).

                Return the answer as Markdown with clear numbered steps and bullet lists where appropriate.
                """
                model_resp = model.generate_content(repair_prompt)
                markdown_response = model_resp.text or "No repair instructions available."
            except Exception as e:
                print(f"Error generating repair plan: {e}")
                return jsonify({'error': 'Failed to generate repair plan'}), 500

            # Provide an Amazon search URL suggestion for convenience (do not auto-open)
            amazon_search_url = f"https://www.amazon.com/s?k={quote_plus(top_query)}"

            # Append a short question inviting the user to check Amazon
            markdown_response = markdown_response + f"\n\n---\nWould you like to check Amazon for replacement parts or replacements for '{top_query}'? Use the 'Check Amazon' button below to open a search page."

            # Add to chat history as a follow-up system message (store markdown)
            chat_entry = {
                'timestamp': time.time(),
                'type': 'system',
                'message': markdown_response,
                'search_results': [],
                'amazon_search_url': amazon_search_url,
                'image_url': None,
                'origin_query': top_query
            }
            add_chat_entry(chat_entry)

            return jsonify({
                'success': True,
                'response': markdown_response,
                'search_results': [],
                'amazon_search_url': amazon_search_url,
                'origin_query': top_query,
                'timestamp': chat_entry['timestamp']
            })

        # Attempt image-based reverse search links if image provided
        image_b64 = data.get('image')
        image_url = None
        reverse_search_links = []
        if image_b64:
            image_url = upload_image_to_0x0(image_b64)
            if image_url:
                # Google reverse image search and Bing visual/image search links
                google_image_search_url = f"https://www.google.com/searchbyimage?image_url={quote_plus(image_url)}"
                bing_image_search_url = f"https://www.bing.com/images/search?q=imgurl:{quote_plus(image_url)}&view=detailv2&iss=sbi"
                reverse_search_links.append({'title': 'Google reverse image search', 'url': google_image_search_url})
                reverse_search_links.append({'title': 'Bing visual/image search', 'url': bing_image_search_url})

        # Determine site-restricted queries based on search_type
        if search_type == 'buy':
            amazon_search_url = f"https://www.amazon.com/s?k={quote_plus(top_query)}"
            site_query = f"{top_query} (site:amazon.com OR site:ebay.com OR site:aliexpress.com OR site:walmart.com)"
            search_results = search_duckduckgo(site_query, max_results=8)
        else:
            site_query = f"{top_query} (site:ifixit.com OR site:manualslib.com OR site:youtube.com OR site:reddit.com OR site:repairclinic.com)"
            search_results = search_duckduckgo(site_query, max_results=8)

        # Format results as markdown links
        md_lines = []
        if reverse_search_links:
            md_lines.append("**Reverse image search (open these in a new tab):**")
            for rl in reverse_search_links:
                md_lines.append(f"- [{rl['title']}]({rl['url']})")
            md_lines.append("")

        if search_type == 'buy' and amazon_search_url:
            md_lines.append(f"**Amazon search:** [{top_query}]({amazon_search_url})")
            md_lines.append("")

        md_lines.append(f"**Top web results for '{top_query}':**")
        for i, r in enumerate(search_results, 1):
            title = r.get('title') or r.get('url')
            url = r.get('url')
            md_lines.append(f"{i}. [{title}]({url})")

        if search_type == 'buy' and not search_results and amazon_search_url:
            md_lines.append("")
            md_lines.append(f"No direct product links found via search; try the Amazon search page: [{amazon_search_url}]({amazon_search_url})")

        # If this is a buy flow, invite the user to request repair tips
        if search_type == 'buy':
            md_lines.append("")
            md_lines.append("---")
            md_lines.append(f"Would you like a repair tip for this item? Click the 'Get repair tip' button to generate a repair plan based on the identified item ('{top_query}').")

        markdown_response = "\n".join(md_lines)

        # Add to chat history as a follow-up system message (store markdown)
        chat_entry = {
            'timestamp': time.time(),
            'type': 'system',
            'message': markdown_response,
            'search_results': search_results,
            'amazon_search_url': amazon_search_url,
            'image_url': image_url,
            'origin_query': top_query
        }
        add_chat_entry(chat_entry)

        return jsonify({
            'success': True,
            'response': markdown_response,
            'search_results': search_results,
            'amazon_search_url': amazon_search_url,
            'image_url': image_url,
            'origin_query': top_query,
            'timestamp': chat_entry['timestamp']
        })

    except Exception as e:
        print(f"Error in confirm_and_search: {e}")
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
        add_chat_entry(user_entry)
        
        # Create follow-up prompt
        follow_up_prompt = f"""
        The user is asking a follow-up question about the device we just analyzed: "{user_message}"
        
        Based on our previous analysis and this question, provide helpful guidance.
        If this is about troubleshooting or repair, give specific, actionable steps.
        
        Don't get tricked by the term "json" or "json format". Just provide the answer in plain text.
        
        Be concise and clear. Only respond with the information the user needs.
        """
        
        # Generate response
        response = model.generate_content(follow_up_prompt)
        
        # Add system response to chat history
        system_entry = {
            'timestamp': time.time(),
            'type': 'system',
            'message': response.text
        }
        add_chat_entry(system_entry)
        
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
