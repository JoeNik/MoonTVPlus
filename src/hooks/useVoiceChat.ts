// React Hook for Voice Chat in Watch Room
'use client';

import { useEffect, useRef, useCallback, useState } from 'react';
import type { WatchRoomSocket } from '@/lib/watch-room-socket';

interface UseVoiceChatOptions {
  socket: WatchRoomSocket | null;
  roomId: string | null;
  isMicEnabled: boolean;
  isSpeakerEnabled: boolean;
}

// 语音聊天策略类型
type VoiceStrategy = 'webrtc-fallback' | 'server-only';

// 获取语音聊天策略配置
function getVoiceStrategy(): VoiceStrategy {
  if (typeof window === 'undefined') return 'webrtc-fallback';
  const strategy = process.env.NEXT_PUBLIC_VOICE_CHAT_STRATEGY || 'webrtc-fallback';
  return strategy as VoiceStrategy;
}

export function useVoiceChat({
  socket,
  roomId,
  isMicEnabled,
  isSpeakerEnabled,
}: UseVoiceChatOptions) {
  const [isConnecting, setIsConnecting] = useState(false);
  const [isConnected, setIsConnected] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [strategy] = useState<VoiceStrategy>(getVoiceStrategy());

  // WebRTC 相关
  const peerConnectionsRef = useRef<Map<string, RTCPeerConnection>>(new Map());
  const localStreamRef = useRef<MediaStream | null>(null);
  const remoteStreamsRef = useRef<Map<string, MediaStream>>(new Map());
  const audioContextRef = useRef<AudioContext | null>(null);
  const remoteAudioElementsRef = useRef<Map<string, HTMLAudioElement>>(new Map());

  // 服务器中转相关
  const mediaRecorderRef = useRef<MediaRecorder | null>(null);

  // ICE服务器配置（使用免费的STUN服务器）
  const iceServers = [
    { urls: 'stun:stun.l.google.com:19302' },
    { urls: 'stun:stun1.l.google.com:19302' },
  ];

  // 获取本地麦克风流
  const getLocalStream = useCallback(async () => {
    try {
      const stream = await navigator.mediaDevices.getUserMedia({
        audio: {
          echoCancellation: true,
          noiseSuppression: true,
          autoGainControl: true,
        },
      });
      localStreamRef.current = stream;
      console.log('[VoiceChat] Got local stream');
      return stream;
    } catch (err) {
      console.error('[VoiceChat] Failed to get local stream:', err);
      setError('无法访问麦克风，请检查权限设置');
      throw err;
    }
  }, []);

  // 停止本地流
  const stopLocalStream = useCallback(() => {
    if (localStreamRef.current) {
      localStreamRef.current.getTracks().forEach(track => track.stop());
      localStreamRef.current = null;
      console.log('[VoiceChat] Stopped local stream');
    }
  }, []);

  // ==================== WebRTC P2P 逻辑 ====================

  // 创建 RTCPeerConnection
  const createPeerConnection = useCallback((peerId: string) => {
    const pc = new RTCPeerConnection({ iceServers });

    // ICE候选收集
    pc.onicecandidate = (event) => {
      if (event.candidate && socket) {
        console.log('[VoiceChat] Sending ICE candidate to', peerId);
        socket.emit('voice:ice', {
          targetUserId: peerId,
          candidate: event.candidate.toJSON(),
        });
      }
    };

    // 接收远程音频流
    pc.ontrack = (event) => {
      console.log('[VoiceChat] Received remote track from', peerId);
      const remoteStream = event.streams[0];
      remoteStreamsRef.current.set(peerId, remoteStream);

      // 创建音频元素播放远程流
      if (isSpeakerEnabled) {
        playRemoteStream(peerId, remoteStream);
      }
    };

    // 连接状态变化
    pc.onconnectionstatechange = () => {
      console.log('[VoiceChat] Connection state with', peerId, ':', pc.connectionState);
      if (pc.connectionState === 'connected') {
        setIsConnected(true);
        setIsConnecting(false);
      } else if (pc.connectionState === 'failed' || pc.connectionState === 'disconnected') {
        // WebRTC连接失败，如果策略允许，切换到服务器中转
        if (strategy === 'webrtc-fallback') {
          console.log('[VoiceChat] WebRTC failed, falling back to server relay');
          switchToServerRelay();
        }
      }
    };

    peerConnectionsRef.current.set(peerId, pc);
    return pc;
  }, [socket, isSpeakerEnabled, strategy]);

  // 播放远程音频流
  const playRemoteStream = useCallback((peerId: string, stream: MediaStream) => {
    let audio = remoteAudioElementsRef.current.get(peerId);
    if (!audio) {
      audio = new Audio();
      audio.autoplay = true;
      remoteAudioElementsRef.current.set(peerId, audio);
    }
    audio.srcObject = stream;
  }, []);

  // 停止播放远程音频流
  const stopRemoteStream = useCallback((peerId: string) => {
    const audio = remoteAudioElementsRef.current.get(peerId);
    if (audio) {
      audio.pause();
      audio.srcObject = null;
      remoteAudioElementsRef.current.delete(peerId);
    }
    remoteStreamsRef.current.delete(peerId);
  }, []);

  // 向对等端发起连接（创建offer）
  const initiateConnection = useCallback(async (peerId: string) => {
    if (!socket || !localStreamRef.current) return;

    console.log('[VoiceChat] Initiating connection to', peerId);
    const pc = createPeerConnection(peerId);

    // 添加本地流
    localStreamRef.current.getTracks().forEach(track => {
      if (localStreamRef.current) {
        pc.addTrack(track, localStreamRef.current);
      }
    });

    // 创建offer
    try {
      const offer = await pc.createOffer();
      await pc.setLocalDescription(offer);

      socket.emit('voice:offer', {
        targetUserId: peerId,
        offer: offer,
      });
      console.log('[VoiceChat] Sent offer to', peerId);
    } catch (err) {
      console.error('[VoiceChat] Failed to create offer:', err);
    }
  }, [socket, createPeerConnection]);

  // 处理接收到的offer
  const handleOffer = useCallback(async (data: { userId: string; offer: RTCSessionDescriptionInit }) => {
    if (!socket || !localStreamRef.current) return;

    console.log('[VoiceChat] Received offer from', data.userId);
    const pc = createPeerConnection(data.userId);

    // 添加本地流
    localStreamRef.current.getTracks().forEach(track => {
      if (localStreamRef.current) {
        pc.addTrack(track, localStreamRef.current);
      }
    });

    try {
      await pc.setRemoteDescription(new RTCSessionDescription(data.offer));
      const answer = await pc.createAnswer();
      await pc.setLocalDescription(answer);

      socket.emit('voice:answer', {
        targetUserId: data.userId,
        answer: answer,
      });
      console.log('[VoiceChat] Sent answer to', data.userId);
    } catch (err) {
      console.error('[VoiceChat] Failed to handle offer:', err);
    }
  }, [socket, createPeerConnection]);

  // 处理接收到的answer
  const handleAnswer = useCallback(async (data: { userId: string; answer: RTCSessionDescriptionInit }) => {
    console.log('[VoiceChat] Received answer from', data.userId);
    const pc = peerConnectionsRef.current.get(data.userId);
    if (!pc) return;

    try {
      await pc.setRemoteDescription(new RTCSessionDescription(data.answer));
    } catch (err) {
      console.error('[VoiceChat] Failed to handle answer:', err);
    }
  }, []);

  // 处理接收到的ICE候选
  const handleIceCandidate = useCallback(async (data: { userId: string; candidate: RTCIceCandidateInit }) => {
    console.log('[VoiceChat] Received ICE candidate from', data.userId);
    const pc = peerConnectionsRef.current.get(data.userId);
    if (!pc) return;

    try {
      await pc.addIceCandidate(new RTCIceCandidate(data.candidate));
    } catch (err) {
      console.error('[VoiceChat] Failed to add ICE candidate:', err);
    }
  }, []);

  // ==================== 服务器中转逻辑 ====================

  // 切换到服务器中转模式
  const switchToServerRelay = useCallback(async () => {
    console.log('[VoiceChat] Switching to server relay mode');
    setError('P2P连接失败，切换到服务器中转模式');

    // 清理WebRTC连接
    cleanupWebRTC();

    // 启动服务器中转
    if (isMicEnabled && localStreamRef.current) {
      startServerRelay();
    }
  }, [isMicEnabled]);

  // 启动服务器中转
  const startServerRelay = useCallback(() => {
    if (!socket || !localStreamRef.current) {
      console.error('[VoiceChat] Cannot start server relay - missing socket or stream');
      return;
    }

    if (!roomId) {
      console.error('[VoiceChat] Cannot start server relay - missing roomId');
      return;
    }

    console.log('[VoiceChat] Starting server relay');

    try {
      // 创建AudioContext来处理音频
      const audioContext = new AudioContext({ sampleRate: 16000 }); // 降低采样率以减少数据量
      const source = audioContext.createMediaStreamSource(localStreamRef.current);

      // 使用ScriptProcessorNode处理音频数据
      const bufferSize = 4096;
      const processor = audioContext.createScriptProcessor(bufferSize, 1, 1);

      // 保存roomId的引用，避免闭包问题
      const currentRoomId = roomId;

      processor.onaudioprocess = (e) => {
        if (!socket || !socket.connected) {
          return;
        }

        const inputData = e.inputBuffer.getChannelData(0);

        // 将Float32Array转换为Int16Array（PCM格式）以减少数据量
        const pcmData = new Int16Array(inputData.length);
        for (let i = 0; i < inputData.length; i++) {
          // 将-1到1的浮点数转换为-32768到32767的整数
          const s = Math.max(-1, Math.min(1, inputData[i]));
          pcmData[i] = s < 0 ? s * 0x8000 : s * 0x7FFF;
        }

        // 发送PCM数据到服务器
        socket.emit('voice:audio-chunk', {
          roomId: currentRoomId,
          audioData: Array.from(new Uint8Array(pcmData.buffer)),
          sampleRate: 16000,
        });
      };

      source.connect(processor);
      processor.connect(audioContext.destination);

      // 保存引用以便清理
      audioContextRef.current = audioContext;
      mediaRecorderRef.current = processor as any; // 存储processor用于清理

      console.log('[VoiceChat] Server relay started');
    } catch (err) {
      console.error('[VoiceChat] Failed to start server relay:', err);
      setError('服务器中转启动失败');
    }
  }, [socket, roomId]);

  // 停止服务器中转
  const stopServerRelay = useCallback(() => {
    if (mediaRecorderRef.current) {
      // ScriptProcessorNode没有stop方法，需要断开连接
      const processor = mediaRecorderRef.current as any;
      if (processor.disconnect) {
        processor.disconnect();
      }
      mediaRecorderRef.current = null;
      console.log('[VoiceChat] Server relay stopped');
    }
  }, []);

  // 播放服务器中转的音频 - 使用Web Audio API播放PCM数据
  const playServerRelayAudio = useCallback(async (userId: string, audioData: number[], sampleRate: number = 16000) => {
    if (!isSpeakerEnabled) return;

    try {
      // 创建AudioContext（如果不存在）
      if (!audioContextRef.current) {
        audioContextRef.current = new AudioContext();
      }

      const audioContext = audioContextRef.current;

      // 将Uint8Array转换回Int16Array (PCM数据)
      const uint8Array = new Uint8Array(audioData);
      const int16Array = new Int16Array(uint8Array.buffer);

      // 将Int16Array转换为Float32Array（AudioBuffer需要的格式）
      const float32Array = new Float32Array(int16Array.length);
      for (let i = 0; i < int16Array.length; i++) {
        // 将-32768到32767的整数转换回-1到1的浮点数
        float32Array[i] = int16Array[i] / (int16Array[i] < 0 ? 0x8000 : 0x7FFF);
      }

      // 创建AudioBuffer
      const audioBuffer = audioContext.createBuffer(1, float32Array.length, sampleRate);
      audioBuffer.getChannelData(0).set(float32Array);

      // 创建AudioBufferSourceNode并播放
      const source = audioContext.createBufferSource();
      source.buffer = audioBuffer;
      source.connect(audioContext.destination);
      source.start();
    } catch (err) {
      console.error('[VoiceChat] Failed to play audio:', err);
      setError('音频播放失败: ' + (err as Error).message);
    }
  }, [isSpeakerEnabled]);

  // ==================== 清理函数 ====================

  // 清理WebRTC连接
  const cleanupWebRTC = useCallback(() => {
    // 关闭所有peer connections
    peerConnectionsRef.current.forEach((pc, peerId) => {
      pc.close();
      stopRemoteStream(peerId);
    });
    peerConnectionsRef.current.clear();

    console.log('[VoiceChat] WebRTC cleaned up');
  }, [stopRemoteStream]);

  // 清理所有连接
  const cleanup = useCallback(() => {
    stopLocalStream();
    cleanupWebRTC();
    stopServerRelay();

    if (audioContextRef.current) {
      audioContextRef.current.close();
      audioContextRef.current = null;
    }

    setIsConnected(false);
    setIsConnecting(false);
    setError(null);

    console.log('[VoiceChat] All cleaned up');
  }, [stopLocalStream, cleanupWebRTC, stopServerRelay]);

  // ==================== 主要控制逻辑 ====================

  // 监听麦克风状态变化
  useEffect(() => {
    if (!socket || !roomId) return;

    if (isMicEnabled) {
      // 开启麦克风
      setIsConnecting(true);
      setError(null);

      getLocalStream()
        .then(() => {
          console.log('[VoiceChat] Local stream ready');

          if (strategy === 'server-only') {
            // 仅使用服务器中转
            startServerRelay();
          } else {
            // 使用WebRTC，失败时自动切换到服务器中转
            // 这里需要获取房间内其他成员列表，然后向每个成员发起连接
            // 这部分逻辑需要在WatchRoomProvider中获取members列表
            console.log('[VoiceChat] WebRTC mode, waiting for peer connections');
          }

          setIsConnecting(false);
        })
        .catch(() => {
          setIsConnecting(false);
        });
    } else {
      // 关闭麦克风
      stopLocalStream();
      cleanupWebRTC();
      stopServerRelay();
    }

    return () => {
      if (!isMicEnabled) {
        cleanup();
      }
    };
  }, [isMicEnabled, socket, roomId, strategy, getLocalStream, stopLocalStream, cleanupWebRTC, stopServerRelay, startServerRelay, cleanup]);

  // 监听喇叭状态变化
  useEffect(() => {
    if (isSpeakerEnabled) {
      // 开启喇叭 - 播放所有远程流
      remoteStreamsRef.current.forEach((stream, peerId) => {
        playRemoteStream(peerId, stream);
      });
    } else {
      // 关闭喇叭 - 静音所有远程流
      remoteAudioElementsRef.current.forEach(audio => {
        audio.muted = true;
      });
    }

    // 恢复音量
    return () => {
      if (isSpeakerEnabled) {
        remoteAudioElementsRef.current.forEach(audio => {
          audio.muted = false;
        });
      }
    };
  }, [isSpeakerEnabled, playRemoteStream]);

  // 监听Socket.IO事件
  useEffect(() => {
    if (!socket) return;

    // WebRTC信令事件
    socket.on('voice:offer', handleOffer);
    socket.on('voice:answer', handleAnswer);
    socket.on('voice:ice', handleIceCandidate);

    // 服务器中转事件
    const handleAudioChunk = (data: { userId: string; audioData: number[]; sampleRate?: number }) => {
      if (strategy === 'server-only' || !peerConnectionsRef.current.has(data.userId)) {
        // 只有在服务器中转模式或WebRTC连接失败时才播放服务器中转的音频
        playServerRelayAudio(data.userId, data.audioData, data.sampleRate || 16000);
      }
    };

    socket.on('voice:audio-chunk', handleAudioChunk);

    return () => {
      socket.off('voice:offer', handleOffer);
      socket.off('voice:answer', handleAnswer);
      socket.off('voice:ice', handleIceCandidate);
      socket.off('voice:audio-chunk', handleAudioChunk);
    };
  }, [socket, strategy, handleOffer, handleAnswer, handleIceCandidate, playServerRelayAudio]);

  // 房间变化时清理
  useEffect(() => {
    return () => {
      cleanup();
    };
  }, [roomId, cleanup]);

  return {
    isConnecting,
    isConnected,
    error,
    strategy,
    initiateConnection, // 暴露给外部使用，用于向新加入的成员发起连接
  };
}
