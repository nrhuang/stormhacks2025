import React, { useState, useEffect, useRef, useCallback } from 'react';
import ReactMarkdown from 'react-markdown';
import './ChatSection.css';

const ChatSection = () => {
  const [messages, setMessages] = useState([
    {
      type: 'system',
      message: 'Welcome! Start your camera and point it at the object you need help with. The AI will use your live video feed as context when you ask questions.',
      timestamp: Date.now()
    }
  ]);
  const [inputMessage, setInputMessage] = useState('');
  const [isSending, setIsSending] = useState(false);

  // NEW: voice recording state/refs
  const [isRecording, setIsRecording] = useState(false);
  const mediaRecorderRef = useRef(null);
  const streamRef = useRef(null);

  const [cameraEnabled, setCameraEnabled] = useState(false);
  const [showClearModal, setShowClearModal] = useState(false);
  const messagesEndRef = useRef(null);

  // TTS audio playback ref
  const audioRef = useRef(null);

  const scrollToBottom = useCallback(() => {
    messagesEndRef.current?.scrollIntoView({ behavior: 'smooth' });
  }, []);

  // Function to play TTS audio
  const playTTSAudio = useCallback((base64Audio) => {
    try {
      if (!base64Audio) return;
      
      // Stop any currently playing audio
      if (audioRef.current) {
        audioRef.current.pause();
        audioRef.current.currentTime = 0;
      }
      
      // Create audio blob from base64
      const audioData = atob(base64Audio);
      const arrayBuffer = new ArrayBuffer(audioData.length);
      const uint8Array = new Uint8Array(arrayBuffer);
      
      for (let i = 0; i < audioData.length; i++) {
        uint8Array[i] = audioData.charCodeAt(i);
      }
      
      const audioBlob = new Blob([arrayBuffer], { type: 'audio/mpeg' });
      const audioUrl = URL.createObjectURL(audioBlob);
      
      // Create and play audio
      const audio = new Audio(audioUrl);
      audioRef.current = audio;
      
      audio.play().catch(error => {
        console.warn('Could not play TTS audio:', error);
      });
      
      // Clean up URL after playing
      audio.addEventListener('ended', () => {
        URL.revokeObjectURL(audioUrl);
      });
      
    } catch (error) {
      console.warn('Error playing TTS audio:', error);
    }
  }, []);

  // perform the clear (called from modal "Clear Chat" button)
  const doClearChat = useCallback(async () => {
    const welcome = {
      type: 'system',
      message: 'Welcome! Start your camera and point it at the object you need help with. The AI will use your live video feed as context when you ask questions.',
      timestamp: Date.now()
    };

    // immediately clear UI
    setMessages([welcome]);

    // stop any ongoing TTS audio
    try { 
      if (audioRef.current) {
        audioRef.current.pause();
        audioRef.current.currentTime = 0;
      }
    } catch (e) { 
      console.warn('Could not stop TTS audio', e); 
    }

    // stop any ongoing speech synthesis (legacy)
    try { window.speechSynthesis?.cancel?.(); } catch (e) { console.warn('Could not cancel speechSynthesis', e); }

    try { scrollToBottom(); } catch (e) {}

    // server-side clear
    try {
      const res = await fetch('/clear_chat', { method: 'POST' });
      const contentType = res.headers.get('content-type') || '';
      if (!res.ok) {
        console.error('Failed to clear chat on server:', res.status, res.statusText);
        setMessages([welcome, { type: 'system', message: 'Warning: Failed to clear chat on server.', timestamp: Date.now() }]);
        return;
      }
      if (!contentType.includes('application/json')) {
        console.warn('clear_chat did not return JSON; response-type:', contentType);
        return;
      }
      const data = await res.json();
      if (!data.success) {
        console.error('Failed to clear chat on server:', data.error);
        setMessages([welcome, { type: 'system', message: 'Warning: Failed to clear chat on server.', timestamp: Date.now() }]);
      }
    } catch (err) {
      console.error('Error clearing chat:', err);
      setMessages([welcome, { type: 'system', message: 'Warning: Error clearing chat on server.', timestamp: Date.now() }]);
    } finally {
      setShowClearModal(false);
    }
  }, [scrollToBottom]);

  const openClearModal = () => setShowClearModal(true);

  useEffect(() => {
    scrollToBottom();
  }, [messages, scrollToBottom]);

  useEffect(() => {
    if (isSending) {
      try { scrollToBottom(); } catch (e) {}
    }
  }, [isSending, scrollToBottom]);

  useEffect(() => {
    const handleCameraStatus = (event) => {
      setCameraEnabled(Boolean(event?.detail?.enabled));
    };

    window.addEventListener('cameraStatus', handleCameraStatus);

    return () => {
      window.removeEventListener('cameraStatus', handleCameraStatus);
    };
  }, []);

  // useEffect(() => {
  //   const last = messages[messages.length - 1];
  //   if (isSending && last && last.type === 'system') {
  //     setIsSending(false);
  //   }
  // }, [messages, isSending]);

  // loadChatHistory moved above effect to avoid hook warnings
  const loadChatHistory = useCallback(async () => {
    try {
      const response = await fetch('/get_chat_history');
      const history = await response.json();

      if (Array.isArray(history) && history.length > 0) {
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
  }, []);

  useEffect(() => {
    loadChatHistory();
  }, [loadChatHistory]);

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
      // Include the latest video frame if available
      const requestBody = { message };
      if (window.latestVideoFrame) {
        requestBody.image = window.latestVideoFrame;
      }

      const response = await fetch('/chat', {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
        },
        body: JSON.stringify(requestBody),
      });

      const result = await response.json();

      if (result.success) {
        setMessages(prev => [...prev, {
          type: 'system',
          message: result.response || '',
          timestamp: result.timestamp || Date.now(),
          product_links: result.product_links,
        }]);
        
        // Play TTS audio if available
        console.log("byeeeeeeeeeeeee")
        if (result.tts_audio) {
          console.log("hellooooooooooo")
          playTTSAudio(result.tts_audio);
        }
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
    return <ReactMarkdown>{text}</ReactMarkdown>;
  };

  // =========================
  // NEW: Voice recording logic
  // =========================
  const startRecording = async () => {
    try {
      if (!navigator.mediaDevices || !window.MediaRecorder) {
        setMessages(prev => [...prev, {
          type: 'system',
          message: 'Your browser does not support voice recording.',
          timestamp: Date.now()
        }]);
        return;
        }
      const stream = await navigator.mediaDevices.getUserMedia({ audio: true });
      streamRef.current = stream;

      const mimeType = MediaRecorder.isTypeSupported('audio/webm;codecs=opus')
        ? 'audio/webm;codecs=opus'
        : (MediaRecorder.isTypeSupported('audio/webm') ? 'audio/webm' : '');

      const mr = new MediaRecorder(stream, mimeType ? { mimeType } : undefined);
      mediaRecorderRef.current = mr;

      const chunks = [];
      mr.ondataavailable = (e) => {
        if (e.data && e.data.size > 0) chunks.push(e.data);
      };

      mr.onstop = async () => {
        try {
          const blob = new Blob(chunks, { type: mimeType || 'audio/webm' });
          const form = new FormData();
          form.append('audio', blob, 'voice.webm');
          
          // Include the latest video frame if available
          if (window.latestVideoFrame) {
            form.append('latest_frame', window.latestVideoFrame);
          }

          const res = await fetch('/process_audio', {
            method: 'POST',
            body: form
          });
          const data = await res.json();

          if (data && data.success) {
            // show transcript as the user's message and assistant reply
            setMessages(prev => [...prev,
              { type: 'user', message: data.transcript, timestamp: Date.now() },
              { type: 'system', message: data.response, timestamp: data.timestamp }
            ]);
            
            // Play TTS audio if available
            if (data.tts_audio) {
              playTTSAudio(data.tts_audio);
            }
          } else {
            throw new Error((data && data.error) || 'Voice transcription failed.');
          }
        } catch (err) {
          console.error('Voice upload error:', err);
          setMessages(prev => [...prev, {
            type: 'system',
            message: 'Sorry, voice processing failed.',
            timestamp: Date.now()
          }]);
        } finally {
          // cleanup stream
          if (streamRef.current) {
            streamRef.current.getTracks().forEach(t => t.stop());
            streamRef.current = null;
          }
        }
      };

      mr.start();
      setIsRecording(true);
    } catch (e) {
      console.error('Microphone error:', e);
      setMessages(prev => [...prev, {
        type: 'system',
        message: 'Microphone permission denied or unavailable.',
        timestamp: Date.now()
      }]);
    }
  };

  const stopRecording = () => {
    try {
      if (mediaRecorderRef.current && mediaRecorderRef.current.state !== 'inactive') {
        mediaRecorderRef.current.stop();
      }
    } catch {}
    setIsRecording(false);
  };
  // =========================

  return (
    <div className="chat-section">
      <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between' }}>
        <h2 className="chat-header">Fix-it Felix</h2>
        <div style={{ display: 'flex', gap: 8 }}>
          <button className="btn btn-secondary" onClick={openClearModal}>Clear Chat</button>
        </div>
      </div>

      <div className="chat-messages">
        {messages.map((msg, index) => (
          <div
            key={index}
            className={`message ${msg.type} ${msg.imageProcessed ? 'image-processed' : ''}`}
          >
            {formatMessage(msg.message)}
            {msg.product_links && (
              <div>
                Here are some purchase links if you are missing any of the items mentioned in my suggestions:
                  {msg.product_links.map((link) => (
                    formatMessage('- <' + link.url + '>')
                  ))}
              </div>
            )}
          </div>
        ))}
        {isSending && (
          <div className="message system typing" aria-live="polite">
            <div className="typing-dots" aria-hidden="true">
             <span className="dot" />
             <span className="dot" />
            <span className="dot" />
           </div>
         </div>
         )}
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

        {/* NEW: Voice button */}
        <button
          onClick={isRecording ? stopRecording : startRecording}
          className={`btn ${isRecording ? 'btn-danger' : 'btn-secondary'}`}
          title={isRecording ? 'Stop & send' : 'Record voice'}
          disabled={!cameraEnabled || isSending}
          style={{ marginLeft: 8 }}
        >
          {isRecording ? 'Stop & Send' : '🎤 Voice'}
        </button>

        <button
          onClick={sendMessage}
          className="btn btn-primary"
          disabled={!cameraEnabled || isSending || !inputMessage.trim()}
          style={{ marginLeft: 8 }}
        >
          {isSending ? 'Sending...' : 'Send'}
        </button>
      </div>

      {/* Clear Chat modal */}
      {showClearModal && (
        <div style={{
          position: 'fixed', left: 0, top: 0, right: 0, bottom: 0,
          background: 'rgba(0,0,0,0.45)', display: 'flex', alignItems: 'center',
          justifyContent: 'center', zIndex: 2000
        }}>
          <div style={{
            width: 'min(520px, 92%)', background: '#fff', borderRadius: 10, padding: 18,
            boxShadow: '0 8px 24px rgba(0,0,0,0.25)'
          }}>
            <h3 style={{ marginTop: 0 }}>Clear chat history?</h3>
            <p style={{ marginTop: 6 }}>This will remove all messages from the conversation on this device. Server history will also be cleared.</p>
            <div style={{ display: 'flex', justifyContent: 'flex-end', gap: 8, marginTop: 12 }}>
              <button className="btn btn-secondary" onClick={() => setShowClearModal(false)}>Cancel</button>
              <button className="btn btn-primary" onClick={doClearChat}>Clear Chat</button>
            </div>
          </div>
        </div>
      )}
    </div>
  );
};

export default ChatSection;