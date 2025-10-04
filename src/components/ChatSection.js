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
      // New flow: show a confirmation box first with identification and suggested queries
      const { identification, queries, timestamp } = event.detail;
      setMessages(prev => [...prev, {
        type: 'confirmation',
        identification: identification || '',
        queries: queries || [],
        timestamp: timestamp || Date.now(),
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
          imageProcessed: entry.image_processed,
          amazon_search_url: entry.amazon_search_url,
          origin_query: entry.origin_query
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

  const confirmAndSearch = async (msgIndex, searchType = 'repair') => {
    // msgIndex is index in messages array of the confirmation message
    const msg = messages[msgIndex];
    if (!msg || msg.type !== 'confirmation') return;
    const queries = msg.queries || [];
    if (queries.length === 0) return;

    // optimistically mark confirmation message as pending
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
          message: m.identification,
          timestamp: Date.now(),
        }) : m));

        // If this was a buy request and an Amazon URL was returned, open it in a new tab
        if (searchType === 'buy' && result.amazon_search_url) {
          try {
            window.open(result.amazon_search_url, '_blank', 'noopener');
          } catch (e) {
            // ignore popup blockers; the markdown will still contain the link
            console.warn('Could not open Amazon URL in new tab', e);
          }
        }

        // Append the returned system message and include amazon_search_url/origin_query so buttons render
        setMessages(prev => [...prev, {
          type: 'system',
          message: result.response,
          timestamp: result.timestamp,
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
        // include amazon_search_url/origin_query if present so user can check Amazon after repair tip
        setMessages(prev => [...prev, {
          type: 'system',
          message: result.response,
          timestamp: result.timestamp,
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

  const formatMessage = (text) => {
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

  return (
    <div className="chat-section">
      <h2 className="chat-header">AI Repair Assistant</h2>
      <div className="chat-messages">
        {messages.map((msg, index) => (
          msg.type === 'confirmation' ? (
            <div key={index} className={`message confirmation`}>
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
              {/* If server provided amazon_search_url or origin_query, show quick action buttons */}
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
