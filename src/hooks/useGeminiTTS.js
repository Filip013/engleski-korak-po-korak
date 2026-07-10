import { useRef, useCallback } from 'react';

const MAX_RETRIES = 2;

export function useGeminiTTS(systemInstruction) {
    const ws = useRef(null);
    const audioContext = useRef(null);
    const nextAudioTime = useRef(0);
    const activeAudioNodes = useRef([]);
    const textQueue = useRef([]);
    const currentTurnData = useRef(null);
    const audioReceivedForCurrentTurn = useRef(false);
    const currentOnComplete = useRef(null);
    const currentOnError = useRef(null);
    const silentAudioRef = useRef(null);
    const currentVoice = useRef(null); // Track the currently connected voice

    const playPCMChunk = useCallback((base64Data) => {
        if (!audioContext.current) return;
        const binaryString = window.atob(base64Data);
        const bytes = new Uint8Array(binaryString.length);
        for (let i = 0; i < binaryString.length; i++) bytes[i] = binaryString.charCodeAt(i);
        const int16Array = new Int16Array(bytes.buffer);
        const audioBuffer = audioContext.current.createBuffer(1, int16Array.length, 24000);
        const channelData = audioBuffer.getChannelData(0);
        for (let i = 0; i < int16Array.length; i++) channelData[i] = int16Array[i] / 32768.0;
        
        const source = audioContext.current.createBufferSource();
        source.buffer = audioBuffer;
        source.connect(audioContext.current.destination);
        
        const currentTime = audioContext.current.currentTime;
        if (nextAudioTime.current < currentTime) nextAudioTime.current = currentTime + 0.05;
        
        source.start(nextAudioTime.current);
        nextAudioTime.current += audioBuffer.duration;
        
        activeAudioNodes.current.push(source);
        source.onended = () => {
            activeAudioNodes.current = activeAudioNodes.current.filter(n => n !== source);
        };
    }, []);

    const stopSpeak = useCallback(() => {
        if (ws.current) { ws.current.close(); ws.current = null; }
        activeAudioNodes.current.forEach(n => { try { n.stop(); } catch(e) {} n.onended = null; });
        activeAudioNodes.current = [];
        textQueue.current = []; 
        currentTurnData.current = null;
        audioReceivedForCurrentTurn.current = false;
        currentVoice.current = null;
        
        if (silentAudioRef.current) silentAudioRef.current.pause();
        if (audioContext.current) nextAudioTime.current = audioContext.current.currentTime; 
        if (currentOnComplete.current) currentOnComplete.current();
        currentOnComplete.current = null;
        currentOnError.current = null;
    }, []);

    const handleSpeak = useCallback((input, onComplete = null, onError = null) => {
        // Input should now be an array of objects: { text: "...", voice: "Leda" | "Puck" }
        const items = Array.isArray(input) ? input : [input];
        const validItems = items.filter(i => i && i.text && i.text.trim());
        if (validItems.length === 0) return;

        const myKey = localStorage.getItem('geminiApiKey');
        if (!myKey) {
            if (onError) onError();
            return;
        }

        if (!audioContext.current) audioContext.current = new (window.AudioContext || window.webkitAudioContext)({ sampleRate: 24000 });
        if (audioContext.current.state === 'suspended') audioContext.current.resume();
        
        stopSpeak();

        if (!silentAudioRef.current) {
            silentAudioRef.current = new Audio('data:audio/mp3;base64,//OExAAAAANIAAAAAExBTUUzLjEwMKqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqq');
            silentAudioRef.current.loop = true;
        }
        silentAudioRef.current.play().catch(() => {});

        nextAudioTime.current = audioContext.current.currentTime;
        currentOnComplete.current = onComplete;
        currentOnError.current = onError;
        
        // Populate the queue
        textQueue.current = validItems.map(item => ({ text: item.text, voice: item.voice || 'Leda', retries: 0 }));

        const sendText = (item) => {
            currentTurnData.current = item;
            audioReceivedForCurrentTurn.current = false; 
            ws.current.send(JSON.stringify({
                clientContent: {
                    turns: [{ role: "user", parts: [{ text: `Read exactly: "${item.text}"` }] }],
                    turnComplete: true
                }
            }));
        };

        const connectAndSetup = (targetVoice) => {
            currentVoice.current = targetVoice;
            ws.current = new WebSocket(`wss://generativelanguage.googleapis.com/ws/google.ai.generativelanguage.v1beta.GenerativeService.BidiGenerateContent?key=${myKey.trim()}`);
            
            ws.current.onopen = () => {
                ws.current.send(JSON.stringify({
                    setup: {
                        model: "models/gemini-3.1-flash-live-preview",
                        generationConfig: { 
                            responseModalities: ["AUDIO"], 
                            speechConfig: { voiceConfig: { prebuiltVoiceConfig: { voiceName: targetVoice } } } 
                        },
                        systemInstruction: { parts: [{ text: systemInstruction }] }
                    }
                }));
            };

            ws.current.onmessage = async (event) => {
                let rawData = event.data;
                if (rawData instanceof Blob) rawData = await rawData.text();
                const msg = JSON.parse(rawData);
                
                if (msg.setupComplete) {
                    sendText(textQueue.current[0]); 
                }

                if (msg.serverContent) {
                    if (msg.serverContent.modelTurn) {
                        for (const part of msg.serverContent.modelTurn.parts) {
                            if (part.inlineData && part.inlineData.mimeType.startsWith("audio/pcm")) {
                                audioReceivedForCurrentTurn.current = true;
                                playPCMChunk(part.inlineData.data);
                            }
                        }
                    }
                    
                    if (msg.serverContent.turnComplete) {
                        if (!audioReceivedForCurrentTurn.current && currentTurnData.current) {
                            if (currentTurnData.current.retries < MAX_RETRIES) {
                                textQueue.current[0].retries++;
                                sendText(textQueue.current[0]); 
                                return; 
                            }
                        }

                        // Remove finished item from queue
                        textQueue.current.shift();

                        const checkCompletion = setInterval(() => {
                            if (activeAudioNodes.current.length === 0) {
                                clearInterval(checkCompletion);
                                
                                if (textQueue.current.length > 0) {
                                    // Process next item
                                    processQueue();
                                } else {
                                    // All done
                                    if (silentAudioRef.current) silentAudioRef.current.pause();
                                    if (currentOnComplete.current) {
                                        currentOnComplete.current();
                                        currentOnComplete.current = null;
                                    }
                                }
                            }
                        }, 200); 
                    }
                }
            };

            ws.current.onerror = () => { if (currentOnError.current) currentOnError.current(); };
        };

        const processQueue = () => {
            if (textQueue.current.length === 0) return;
            const nextVoice = textQueue.current[0].voice;

            // If voice changed, or we don't have a connection, open a new one
            if (!ws.current || ws.current.readyState !== WebSocket.OPEN || currentVoice.current !== nextVoice) {
                if (ws.current) ws.current.close();
                connectAndSetup(nextVoice);
            } else {
                sendText(textQueue.current[0]);
            }
        };

        // Kick off the queue processing
        processQueue();

    }, [playPCMChunk, stopSpeak, systemInstruction]);

    return { handleSpeak, stopSpeak };
}