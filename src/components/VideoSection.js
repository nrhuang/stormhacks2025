import React, { useState, useRef, useCallback, useEffect } from 'react';
import './VideoSection.css';

const VideoSection = () => {
  const [stream, setStream] = useState(null);
  const [isProcessing, setIsProcessing] = useState(false);
  const [status, setStatus] = useState({ message: '', type: '', visible: false });
  const [isRecording, setIsRecording] = useState(false);
  const videoRef = useRef(null);
  const canvasRef = useRef(null);
  const recordingIntervalRef = useRef(null);

  const showStatus = useCallback((message, type) => {
    setStatus({ message, type, visible: true });
    if (type === 'success' || type === 'info') {
      setTimeout(() => setStatus(prev => ({ ...prev, visible: false })), 3000);
    }
  }, []);

  const hideStatus = useCallback(() => {
    setStatus(prev => ({ ...prev, visible: false }));
  }, []);

  const captureCurrentFrame = useCallback(() => {
    if (!videoRef.current || !canvasRef.current) return null;
    
    const video = videoRef.current;
    const canvas = canvasRef.current;
    const ctx = canvas.getContext('2d');

    canvas.width = video.videoWidth;
    canvas.height = video.videoHeight;
    ctx.drawImage(video, 0, 0);

    return canvas.toDataURL('image/jpeg', 0.8);
  }, []);

  const startContinuousRecording = useCallback(() => {
    if (recordingIntervalRef.current) {
      clearInterval(recordingIntervalRef.current);
    }

    // Capture frame every 2 seconds and store it globally for AI context
    recordingIntervalRef.current = setInterval(() => {
      const frameData = captureCurrentFrame();
      if (frameData) {
        // Store the latest frame globally so AI can access it
        window.latestVideoFrame = frameData;
      }
    }, 2000);

    setIsRecording(true);
    showStatus('Recording started - AI can now see your camera feed', 'success');
  }, [captureCurrentFrame, showStatus]);

  const stopContinuousRecording = useCallback(() => {
    if (recordingIntervalRef.current) {
      clearInterval(recordingIntervalRef.current);
      recordingIntervalRef.current = null;
    }
    setIsRecording(false);
    window.latestVideoFrame = null;
    showStatus('Recording stopped', 'info');
  }, [showStatus]);

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

      // Wait a moment for video to be ready, then start recording
      setTimeout(() => {
        startContinuousRecording();
      }, 1000);

      // Emit camera status event
      window.dispatchEvent(new CustomEvent('cameraStatus', {
        detail: { enabled: true }
      }));

    } catch (error) {
      console.error('Error accessing camera:', error);
      showStatus('Error accessing camera. Please check permissions.', 'error');
    }
  }, [showStatus, startContinuousRecording]);

  const stopCamera = useCallback(() => {
    // Stop continuous recording first
    stopContinuousRecording();
    
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
  }, [stream, showStatus, stopContinuousRecording]);

  // Cleanup on unmount
  useEffect(() => {
    return () => {
      if (recordingIntervalRef.current) {
        clearInterval(recordingIntervalRef.current);
      }
      window.latestVideoFrame = null;
    };
  }, []);
  

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
          Start Camera & Recording
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

