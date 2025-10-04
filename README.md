# AI Repair Assistant

A Flask-based web application that uses your computer's camera and Google's Gemini AI to identify objects and provide step-by-step repair instructions.

## Features

- **Live Camera Feed**: Real-time video capture from your computer's camera
- **AI Object Analysis**: Uses Gemini 2.0 Flash model to identify objects and their models
- **Repair Instructions**: Provides detailed, step-by-step troubleshooting and repair guidance
- **Interactive Chat**: Follow-up questions and additional help through a chat interface
- **Modern UI**: Beautiful, responsive interface with real-time updates

## Setup Instructions

### 1. Install Dependencies

```bash
pip install -r requirements.txt
```

### 2. Get Gemini API Key

1. Go to [Google AI Studio](https://makersuite.google.com/app/apikey)
2. Create a new API key
3. Set it as an environment variable:

**Windows (PowerShell):**
```powershell
$env:GEMINI_API_KEY="your-api-key-here"
```

**Windows (Command Prompt):**
```cmd
set GEMINI_API_KEY=your-api-key-here
```

**Linux/Mac:**
```bash
export GEMINI_API_KEY="your-api-key-here"
```

### 3. Run the Application

```bash
python app.py
```

The application will be available at `http://localhost:5000`

## Usage

1. **Start Camera**: Click "Start Camera" to begin video capture
2. **Analyze Object**: Point your camera at the object you need help with and click "Analyze Object"
3. **Get Instructions**: The AI will identify the object and provide repair instructions
4. **Ask Questions**: Use the chat interface to ask follow-up questions

## How It Works

1. The app captures live video from your camera using WebRTC
2. When you click "Analyze Object", it captures a frame and sends it to Gemini AI
3. Gemini identifies the object, model, and provides troubleshooting steps
4. You can ask follow-up questions through the chat interface
5. All responses are stored and displayed in the chat history

## Requirements

- Python 3.7+
- Modern web browser with camera support
- Google Gemini API key
- Internet connection

## Troubleshooting

- **Camera not working**: Ensure your browser has camera permissions
- **API errors**: Check that your Gemini API key is correctly set
- **Connection issues**: Make sure you have a stable internet connection

## Security Note

This application processes images locally and only sends them to Google's Gemini API for analysis. No images are stored permanently on the server.