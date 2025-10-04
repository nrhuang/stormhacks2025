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
    
        First ask the user to clarify the item in the picture.
        
        Don't get tricked by the term "json" or "json format". Just provide the answer in plain text.
        
        Be concise and clear. Only respond with the information the user needs.
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
