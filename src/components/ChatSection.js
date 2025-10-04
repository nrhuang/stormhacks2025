import React, { useState, useEffect, useRef, useCallback } from 'react';
import './ChatSection.css';

const ChatSection = () => {
  const [messages, setMessages] = useState([
    {
      type: 'system',
      message: 'Welcome! Start your camera and point it at the object you need help with. Click "Analyze Object" to get step-by-step repair instructions.',
      timestamp: Date.now()
    }
  ]);
  const [inputMessage, setInputMessage] = useState('');
  const [isSending, setIsSending] = useState(false);
  const [cameraEnabled, setCameraEnabled] = useState(false);
  const messagesEndRef = useRef(null);

  const scrollToBottom = useCallback(() => {
    messagesEndRef.current?.scrollIntoView({ behavior: 'smooth' });
  }, []);

  useEffect(() => {
    scrollToBottom();
  }, [messages, scrollToBottom]);

  useEffect(() => {
    const handleImageAnalyzed = (event) => {
      const { message, timestamp } = event.detail;
      setMessages(prev => [...prev, {
        type: 'system',
        message,
        timestamp,
        imageProcessed: true
      }]);
    };

    const handleCameraStatus = (event) => {
      setCameraEnabled(event.detail.enabled);
    };

    window.addEventListener('imageAnalyzed', handleImageAnalyzed);
    window.addEventListener('cameraStatus', handleCameraStatus);

    return () => {
      window.removeEventListener('imageAnalyzed', handleImageAnalyzed);
      window.removeEventListener('cameraStatus', handleCameraStatus);
    };
  }, []);

  useEffect(() => {
    loadChatHistory();
  }, []);

  const loadChatHistory = async () => {
    try {
      const response = await fetch('/get_chat_history');
      const history = await response.json();

      if (history.length > 0) {
        setMessages(history.map(entry => ({
          type: entry.type,
          message: entry.message,
          timestamp: entry.timestamp,
          imageProcessed: entry.image_processed
        })));
      }
    } catch (error) {
      console.error('Error loading chat history:', error);
    }
  };

  const sendMessage = async () => {
    const message = inputMessage.trim();
    if (!message || isSending) return;

    setMessages(prev => [...prev, {
      type: 'user',
      message,
      timestamp: Date.now()
    }]);
    setInputMessage('');
    setIsSending(true);

    try {
      const response = await fetch('/chat', {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
        },
        body: JSON.stringify({ message }),
      });

      const result = await response.json();

      if (result.success) {
        setMessages(prev => [...prev, {
          type: 'system',
          message: result.response,
          timestamp: result.timestamp
        }]);
      } else {
        throw new Error(result.error || 'Chat failed');
      }
    } catch (error) {
      console.error('Error sending message:', error);
      setMessages(prev => [...prev, {
        type: 'system',
        message: 'Sorry, there was an error processing your message.',
        timestamp: Date.now()
      }]);
    } finally {
      setIsSending(false);
    }
  };

  const handleKeyPress = (e) => {
    if (e.key === 'Enter') {
      sendMessage();
    }
  };

  const formatMessage = (text) => {
    return text.split('\n').map((line, index) => (
      <React.Fragment key={index}>
        {line}
        {index < text.split('\n').length - 1 && <br />}
      </React.Fragment>
    ));
  };

  return (
    <div className="chat-section">
      <h2 className="chat-header">AI Repair Assistant</h2>
      <div className="chat-messages">
        {messages.map((msg, index) => (
          <div
            key={index}
            className={`message ${msg.type} ${msg.imageProcessed ? 'image-processed' : ''}`}
          >
            {formatMessage(msg.message)}
          </div>
        ))}
        <div ref={messagesEndRef} />
      </div>
      <div className="chat-input-container">
        <input
          type="text"
          value={inputMessage}
          onChange={(e) => setInputMessage(e.target.value)}
          onKeyPress={handleKeyPress}
          className="chat-input"
          placeholder="Ask a follow-up question..."
          disabled={!cameraEnabled}
        />
        <button
          onClick={sendMessage}
          className="btn btn-primary"
          disabled={!cameraEnabled || isSending || !inputMessage.trim()}
        >
          {isSending ? 'Sending...' : 'Send'}
        </button>
      </div>
    </div>
  );
};

export default ChatSection;
