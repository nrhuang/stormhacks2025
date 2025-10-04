import React, { useState, useEffect, useRef, useCallback } from 'react';
import ReactMarkdown from 'react-markdown';
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

  // NEW: voice recording state/refs
  const [isRecording, setIsRecording] = useState(false);
  const mediaRecorderRef = useRef(null);
  const streamRef = useRef(null);

  const [cameraEnabled, setCameraEnabled] = useState(false);
  const [showClearModal, setShowClearModal] = useState(false);
  const messagesEndRef = useRef(null);

  const scrollToBottom = useCallback(() => {
    messagesEndRef.current?.scrollIntoView({ behavior: 'smooth' });
  }, []);

  // perform the clear (called from modal "Clear Chat" button)
  const doClearChat = useCallback(async () => {
    const welcome = {
      type: 'system',
      message: 'Welcome! Start your camera and point it at the object you need help with. Click "Analyze Object" to get step-by-step repair instructions.',
      timestamp: Date.now()
    };

    // immediately clear UI
    setMessages([welcome]);

    // stop any ongoing speech
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
    const handleImageAnalyzed = (event) => {
      // Add a confirmation message into the chatbox (no popup)
      const { identification, queries, timestamp } = event.detail || {};
      const entry = {
        type: 'confirmation',
        identification: identification || '',
        queries: queries || [],
        timestamp: timestamp || Date.now()
      };
      setMessages(prev => [...prev, entry]);
      // keep camera status handling elsewhere
    };

    const handleCameraStatus = (event) => {
      setCameraEnabled(Boolean(event?.detail?.enabled));
    };

    window.addEventListener('imageAnalyzed', handleImageAnalyzed);
    window.addEventListener('cameraStatus', handleCameraStatus);

    return () => {
      window.removeEventListener('imageAnalyzed', handleImageAnalyzed);
      window.removeEventListener('cameraStatus', handleCameraStatus);
    };
  }, []);

  // loadChatHistory moved above effect to avoid hook warnings
  const loadChatHistory = useCallback(async () => {
    try {
      const response = await fetch('/get_chat_history');
      const history = await response.json();

      if (Array.isArray(history) && history.length > 0) {
        setMessages(history.map(entry => ({
          type: entry.type || 'system',
          message: entry.message || '',
          timestamp: entry.timestamp || Date.now(),
          imageProcessed: entry.image_processed || false,
          amazon_search_url: entry.amazon_search_url,
          origin_query: entry.origin_query,
          // keep identification/queries if present
          identification: entry.identification,
          queries: entry.queries
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
          message: result.response || '',
          timestamp: result.timestamp || Date.now()
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

  const confirmAndSearch = async (msgIndex, searchType = 'repair') => {
    const msg = messages[msgIndex];
    if (!msg || msg.type !== 'confirmation') return;
    const queries = msg.queries || [];
    if (queries.length === 0) return;

    setMessages(prev => prev.map((m, i) => i === msgIndex ? { ...m, pending: true } : m));

    try {
      const resp = await fetch('/confirm_and_search', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ queries, queryIndex: 0, searchType }),
      });
      const result = await resp.json();
      if (result.success) {
        // replace confirmation message with the identification (as system) and append search results
        setMessages(prev => prev.map((m, i) => i === msgIndex ? ({
          type: 'system',
          message: m.identification || '',
          timestamp: Date.now(),
        }) : m));

        if (searchType === 'buy' && result.amazon_search_url) {
          try {
            window.open(result.amazon_search_url, '_blank', 'noopener');
          } catch (e) {
            console.warn('Could not open Amazon URL in new tab', e);
          }
        }

        setMessages(prev => [...prev, {
          type: 'system',
          message: result.response || '',
          timestamp: result.timestamp || Date.now(),
          amazon_search_url: result.amazon_search_url,
          origin_query: result.origin_query
        }]);
      } else {
        throw new Error(result.error || 'Search failed');
      }
    } catch (error) {
      console.error('Error confirming and searching:', error);
      setMessages(prev => [...prev, {
        type: 'system',
        message: 'Error performing search: ' + (error.message || ''),
        timestamp: Date.now()
      }]);
    }
  };

  const getRepairTip = async (originQuery) => {
    if (!originQuery) return;
    try {
      const resp = await fetch('/confirm_and_search', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ queries: [originQuery], queryIndex: 0, searchType: 'repair' }),
      });
      const result = await resp.json();
      if (result.success) {
        setMessages(prev => [...prev, {
          type: 'system',
          message: result.response || '',
          timestamp: result.timestamp || Date.now(),
          amazon_search_url: result.amazon_search_url,
          origin_query: result.origin_query
        }]);
      } else {
        throw new Error(result.error || 'Failed to get repair tip');
      }
    } catch (e) {
      console.error('Error fetching repair tip:', e);
      setMessages(prev => [...prev, { type: 'system', message: 'Error fetching repair tip.', timestamp: Date.now() }]);
    }
  };

  const openAmazon = (url) => {
    if (!url) return;
    try {
      window.open(url, '_blank', 'noopener');
    } catch (e) {
      console.warn('Could not open Amazon URL', e);
    }
  };

  const handleKeyPress = (e) => {
    if (e.key === 'Enter') {
      sendMessage();
    }
  };

  const formatMessage = (text = '') => {
    return (
      <ReactMarkdown
        components={{
          a: ({ node, ...props }) => (
            <a {...props} target="_blank" rel="noopener noreferrer" />
          ),
        }}
      >
        {text}
      </ReactMarkdown>
    );
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
        <h2 className="chat-header">AI Repair Assistant</h2>
        <div style={{ display: 'flex', gap: 8 }}>
          <button className="btn btn-secondary" onClick={openClearModal}>Clear Chat</button>
        </div>
      </div>

      <div className="chat-messages">
        {messages.map((msg, index) => (
          msg.type === 'confirmation' ? (
            <div key={index} className={`message confirmation ${msg.pending ? 'pending' : ''}`}>
              <div style={{ marginBottom: 8 }}>
                <strong>Please confirm the item:</strong>
              </div>
              <div style={{ marginBottom: 8 }}>{formatMessage(msg.identification)}</div>
              <div style={{ marginBottom: 8 }}>
                Suggested searches:
                <ul>
                  {(msg.queries || []).map((q, i) => <li key={i}>{q}</li>)}
                </ul>
              </div>
              <div style={{ display: 'flex', gap: 8 }}>
                <button
                  onClick={() => confirmAndSearch(index, 'repair')}
                  className="btn btn-secondary"
                  disabled={msg.pending}
                >
                  Find repair solutions
                </button>
                <button
                  onClick={() => confirmAndSearch(index, 'buy')}
                  className="btn btn-primary"
                  disabled={msg.pending}
                >
                  Search Amazon for replacements
                </button>
              </div>
            </div>
          ) : (
            <div
              key={index}
              className={`message ${msg.type} ${msg.imageProcessed ? 'image-processed' : ''}`}
            >
              {formatMessage(msg.message)}
              {(msg.amazon_search_url || msg.origin_query) && (
                <div style={{ marginTop: 8, display: 'flex', gap: 8 }}>
                  {msg.amazon_search_url && (
                    <button
                      onClick={() => openAmazon(msg.amazon_search_url)}
                      className="btn btn-primary"
                    >
                      Check Amazon
                    </button>
                  )}
                  {msg.origin_query && (
                    <button
                      onClick={() => getRepairTip(msg.origin_query)}
                      className="btn btn-secondary"
                    >
                      Get repair tip
                    </button>
                  )}
                </div>
              )}
            </div>
          )
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