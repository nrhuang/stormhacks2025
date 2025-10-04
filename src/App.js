// ...existing code...
import React from 'react';
import './App.css';
import VideoSection from './components/VideoSection';
import ChatSection from './components/ChatSection';

function App() {
  // Called after the AI response is added to the UI
  async function handleAiResponse(responseText) {
    if (window && typeof window.speakTextFromMarkdown === 'function') {
      try {
        window.speakTextFromMarkdown(responseText);
      } catch (e) {
        console.warn('speak failed', e);
      }
    }
  }

  return (
    <div className="container">
      <VideoSection />
      <ChatSection onAiResponse={handleAiResponse} />
    </div>
  );
}

export default App;
// ...existing code...