import React, { useState, useRef, useCallback } from 'react';
import './VideoSection.css';

const VideoSection = () => {
  const [stream, setStream] = useState(null);
  const [isProcessing, setIsProcessing] = useState(false);
  const [status, setStatus] = useState({ message: '', type: '', visible: false });
  const videoRef = useRef(null);
  const canvasRef = useRef(null);

  const showStatus = useCallback((message, type) => {
    setStatus({ message, type, visible: true });
    if (type === 'success' || type === 'info') {
      setTimeout(() => setStatus(prev => ({ ...prev, visible: false })), 3000);
    }
  }, []);

  const hideStatus = useCallback(() => {
    setStatus(prev => ({ ...prev, visible: false }));
  }, []);

  const startCamera = useCallback(async () => {
    try {
      showStatus('Starting camera...', 'info');
      const mediaStream = await navigator.mediaDevices.getUserMedia({
        video: {
          width: { ideal: 1280 },
          height: { ideal: 720 },
        },
      });

      setStream(mediaStream);
      if (videoRef.current) {
        videoRef.current.srcObject = mediaStream;
      }

      // Emit camera status event
      window.dispatchEvent(new CustomEvent('cameraStatus', {
        detail: { enabled: true }
      }));

      showStatus('Camera started successfully!', 'success');
    } catch (error) {
      console.error('Error accessing camera:', error);
      showStatus('Error accessing camera. Please check permissions.', 'error');
    }
  }, [showStatus]);

  const stopCamera = useCallback(() => {
    if (stream) {
      stream.getTracks().forEach((track) => track.stop());
      setStream(null);
    }

    if (videoRef.current) {
      videoRef.current.srcObject = null;
    }

    // Emit camera status event
    window.dispatchEvent(new CustomEvent('cameraStatus', {
      detail: { enabled: false }
    }));

    showStatus('Camera stopped.', 'info');
  }, [stream, showStatus]);
  
  const captureAndAnalyze = useCallback(async () => {
  if (isProcessing || !videoRef.current || !canvasRef.current) return;

  setIsProcessing(true);
  showStatus('Analyzing object...', 'info');

  // Dispatch event that image analysis has started
  window.dispatchEvent(new Event('imageAnalysisStarted'));
  console.log('Image analysis started');

  try {
    const video = videoRef.current;
    const canvas = canvasRef.current;
    const ctx = canvas.getContext('2d');

    canvas.width = video.videoWidth;
    canvas.height = video.videoHeight;
    ctx.drawImage(video, 0, 0);

    const imageData = canvas.toDataURL('image/jpeg', 0.8);

    const response = await fetch('/process_frame', {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
      },
      body: JSON.stringify({ image: imageData }),
    });

    const result = await response.json();

      if (result.success) {
        // Emit event to chat section to add the message
        window.dispatchEvent(new CustomEvent('imageAnalyzed', {
          detail: { message: result.response, timestamp: result.timestamp }
        }));
        showStatus('Analysis complete!', 'success');
      } else {
        throw new Error(result.error || 'Analysis failed');
      }
    } catch (error) {
    console.error('Error analyzing frame:', error);
    showStatus('Error analyzing object: ' + error.message, 'error');
    } finally {
      setIsProcessing(false);

      // Dispatch event that analysis is finished
      window.dispatchEvent(new Event('imageAnalysisFinished'));
      console.log('Image analysis finished');

      setTimeout(() => hideStatus(), 3000);
    }
  }, [isProcessing, showStatus, hideStatus]);

  return (
    <div className="video-section">
      <h2 style={{ textAlign: 'center', marginBottom: '20px', color: '#333' }}>
        Live Camera Feed
      </h2>
      <div className="video-container">
        <video ref={videoRef} className="video-element" autoPlay muted />
        <canvas ref={canvasRef} style={{ display: 'none' }} />
      </div>
      <div className="controls">
        <button 
          className="btn btn-primary" 
          onClick={startCamera}
          disabled={stream !== null}
        >
          Start Camera
        </button>
        <button 
          className="btn btn-secondary" 
          onClick={captureAndAnalyze}
          disabled={stream === null || isProcessing}
        >
          {isProcessing ? 'Analyzing...' : 'Analyze Object'}
        </button>
        <button 
          className="btn btn-secondary" 
          onClick={stopCamera}
          disabled={stream === null}
        >
          Stop Camera
        </button>
      </div>
      <div className={`status ${status.type} ${status.visible ? '' : 'hidden'}`}>
        {status.message}
      </div>
    </div>
  );
};

export default VideoSection;
