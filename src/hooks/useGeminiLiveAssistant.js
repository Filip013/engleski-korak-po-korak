import { useState, useRef, useCallback } from 'react';

export function useGeminiLiveAssistant() {
    const ws = useRef(null);
    const audioContext = useRef(null);
    const micStream = useRef(null);
    const scriptProcessor = useRef(null);
    const nextAudioTime = useRef(0);
    const activeAudioNodes = useRef([]);

    const [isActive, setIsActive] = useState(false);
    const [isConnecting, setIsConnecting] = useState(false);
    const [isSpeaking, setIsSpeaking] = useState(false);

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
            if (activeAudioNodes.current.length === 0) setIsSpeaking(false);
        };
    }, []);

    const stopAssistant = useCallback(() => {
        setIsActive(false);
        setIsConnecting(false);
        setIsSpeaking(false);
        if (ws.current) { ws.current.close(); ws.current = null; }
        if (micStream.current) { micStream.current.getTracks().forEach(t => t.stop()); micStream.current = null; }
        if (scriptProcessor.current) { scriptProcessor.current.disconnect(); scriptProcessor.current = null; }
        if (audioContext.current) { audioContext.current.close(); audioContext.current = null; }
        activeAudioNodes.current.forEach(n => { try { n.stop(); } catch(e) {} n.onended = null; });
        activeAudioNodes.current = [];
    }, []);

    const startAssistant = useCallback(async (initialContext) => {
        const myKey = localStorage.getItem('geminiApiKey');
        if (!myKey) { alert("API кључ је неопходан."); return; }

        setIsConnecting(true);

        try {
            micStream.current = await navigator.mediaDevices.getUserMedia({ 
                audio: { echoCancellation: true, noiseSuppression: true, autoGainControl: true } 
            });
        } catch (e) {
            alert("Мораш дозволити приступ микрофону за гласовног асистента.");
            setIsConnecting(false);
            return;
        }

        audioContext.current = new (window.AudioContext || window.webkitAudioContext)({ sampleRate: 24000 });
        nextAudioTime.current = audioContext.current.currentTime;

        const micContext = new (window.AudioContext || window.webkitAudioContext)({ sampleRate: 16000 });
        const source = micContext.createMediaStreamSource(micStream.current);
        // Using ScriptProcessorNode is perfectly fine here despite the browser warning
        scriptProcessor.current = micContext.createScriptProcessor(4096, 1, 1);
        source.connect(scriptProcessor.current);
        scriptProcessor.current.connect(micContext.destination);

        ws.current = new WebSocket(`wss://generativelanguage.googleapis.com/ws/google.ai.generativelanguage.v1beta.GenerativeService.BidiGenerateContent?key=${myKey.trim()}`);

        ws.current.onopen = () => {
            const sysInstruction = `You are a warm, helpful voice AI English tutor for a native Serbian speaker. 
            RULES:
            1. Keep answers short.
            2. Speak Serbian, unless demonstrating an English word.
            3. Address the Serbian part of the context, but don't reveal the English sentence immediately.
            
            Current context the user is looking at right now:\n${JSON.stringify(initialContext, null, 2)}`;

            ws.current.send(JSON.stringify({
                setup: {
                    model: "models/gemini-3.1-flash-live-preview", // Restored to your original model
                    generationConfig: {
                        responseModalities: ["AUDIO"],
                        speechConfig: { voiceConfig: { prebuiltVoiceConfig: { voiceName: "Leda" } } } // Restored to your original voice
                    },
                    systemInstruction: { parts: [{ text: sysInstruction }] }
                }
            }));
        };

        ws.current.onmessage = async (event) => {
            let rawData = event.data;
            if (rawData instanceof Blob) rawData = await rawData.text();
            const msg = JSON.parse(rawData);

            if (msg.setupComplete) {
                setIsConnecting(false);
                setIsActive(true);

                // Initial prompt to start the conversation
                ws.current.send(JSON.stringify({
                    realtimeInput: {
                        text: "Управо те позивам у помоћ. Укратко ме поздрави на српском и питај ме у вези чега ми треба помоћ из приложеног контекста."
                    }
                }));

                // Start processing microphone input
                scriptProcessor.current.onaudioprocess = (e) => {
                    if (!ws.current || ws.current.readyState !== WebSocket.OPEN) return;
                    
                    const channelData = e.inputBuffer.getChannelData(0);
                    const pcm16 = new Int16Array(channelData.length);
                    for (let i = 0; i < channelData.length; i++) {
                        pcm16[i] = Math.max(-1, Math.min(1, channelData[i])) * 0x7FFF;
                    }
                    
                    const bytes = new Uint8Array(pcm16.buffer);
                    let binary = '';
                    for (let i = 0; i < bytes.byteLength; i += 1024) {
                        binary += String.fromCharCode.apply(null, bytes.subarray(i, i + Math.min(1024, bytes.byteLength - i)));
                    }

                    // Send background audio stream using realtimeInput so it doesn't interrupt the initial greeting
                    ws.current.send(JSON.stringify({
                        realtimeInput: {
                            audio: {
                                mimeType: "audio/pcm;rate=16000",
                                data: window.btoa(binary)
                            }
                        }
                    }));
                };
            }

            if (msg.serverContent && msg.serverContent.modelTurn) {
                setIsSpeaking(true);
                for (const part of msg.serverContent.modelTurn.parts) {
                    if (part.inlineData && part.inlineData.mimeType.startsWith("audio/pcm")) {
                        playPCMChunk(part.inlineData.data);
                    }
                }
            }
        };

        ws.current.onerror = (err) => stopAssistant();
        ws.current.onclose = (e) => stopAssistant();

    }, [playPCMChunk, stopAssistant]);

    const updateContext = useCallback((newContext) => {
        if (ws.current && ws.current.readyState === WebSocket.OPEN) {
            ws.current.send(JSON.stringify({
                realtimeInput: {
                    text: `(Системска порука): Корисник је управо кликнуо на нову ставку. Ево новог контекста: ${JSON.stringify(newContext)}. Укратко потврди да пратиш.`
                }
            }));
        } else {
            startAssistant(newContext);
        }
    }, [startAssistant]);

    return { isActive, isConnecting, isSpeaking, startAssistant, stopAssistant, updateContext };
}