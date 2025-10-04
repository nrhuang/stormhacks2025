import React from 'react';
import './App.css';
import VideoSection from './components/VideoSection';
import ChatSection from './components/ChatSection';

function App() {
  return (
    <div className="container">
      <VideoSection />
      <ChatSection />
    </div>
  );
}

export default App;
