import React, { useState, useEffect, useMemo } from 'react';
import { signInWithPopup, GoogleAuthProvider, signOut, onAuthStateChanged } from 'firebase/auth';
import { doc, setDoc, onSnapshot, collection, query, orderBy, limit, writeBatch, deleteDoc, getDoc, getDocs } from 'firebase/firestore';
import { DndContext, closestCenter, KeyboardSensor, PointerSensor, TouchSensor, useSensor, useSensors } from '@dnd-kit/core';
import { arrayMove, SortableContext, sortableKeyboardCoordinates, horizontalListSortingStrategy, useSortable } from '@dnd-kit/sortable';
import { CSS } from '@dnd-kit/utilities';
import { auth, db } from './firebase';
import { useGeminiTTS } from './hooks/useGeminiTTS';
import { useGeminiLiveAssistant } from './hooks/useGeminiLiveAssistant';
import { usePWAInstall } from './hooks/usePWAInstall';
import { 
  BookOpen, Volume2, Pause, Lightbulb, CheckCircle, Search, Tag, 
  Hash, Sun, Moon, Check, Compass, Layers, MessageSquare, MessageCircle, 
  Eye, Loader2, Play, Settings, ClipboardPaste, Download, Trash2,
  HelpCircle, X, Send, Bot, Mic, MicOff, AudioLines, Smartphone
} from 'lucide-react';

const APP_ID = 'english-serbian-seniors';
const SYSTEM_PROMPT = `You are an expert English language tutor creating highly structured lessons for native Serbian speakers (absolute beginners A1). 
        
CRITICAL RULES:
1. NEW WORDS: Present around 5 NEW WORDS to teach, PLUS any additional words the user explicitly requests.
2. KNOWN VOCABULARY: The Dialog, Grammar, Drills, and Quiz MUST NOT contain any unknown English words outside the provided 'KNOWN VOCABULARY' list + the new target words.
3. TONE & DIFFICULTY: Keep sentences short, practical, and polite. Everyday situations.
4. DIALOG: A realistic short conversation ('dialog' array) using known words and the new words. Assign gender ("M" or "F").
5. GRAMMAR: Provide several short, simple rules in Serbian explaining the concepts used in the dialog.
6. DRILLS: Exactly 20 sentences for listen-and-repeat. Mix new words and known vocabulary. Assign gender.
7. QUIZ: Exactly 20 questions. Create 10 alternating pairs (1 'listening' followed by 1 'translation'). 
   - 'translation' type: 'prompt' is a Serbian sentence to translate.
   - 'listening' type: 'prompt' MUST literally be "Слушајте и сложите реченицу."
   For BOTH types: 'target' is the correct English sentence to assemble. 'options' must contain correct scrambled words + 3 distractors. Assign gender and the 'type' field.
8. OUTPUT: Strictly output valid JSON. No markdown formatting.`;

const JSON_SCHEMA = `{
  "title": "У ресторану",
  "tutorIntroduction": "Данас учимо како да наручимо храну!",
  "dialog": [{ "speaker": "Ана", "en": "English", "sr": "Serbian", "gender": "F" }],
  "grammar": [{ "title": "Concept", "explanation": "Rule in Serbian" }],
  "drills": [{ "en": "English sentence", "sr": "Serbian translation", "gender": "M" }],
  "quiz": [{ "type": "translation", "prompt": "Serbian to translate", "target": "Correct English", "options": ["word1", "word2", "wrong1"], "gender": "F" }],
  "newLemmas": [{ "english": "word", "pronunciation": "wɜːrd", "serbian": "реч", "pos": "Именица" }]
}`;

const cleanText = (str) => str.toLowerCase().replace(/[.,!?]/g, '');
const shuffleArray = (array) => [...array].sort(() => Math.random() - 0.5);

function SortableWordTile({ id, wordText, onRemove }) {
  const {
    attributes,
    listeners,
    setNodeRef,
    transform,
    transition,
    isDragging
  } = useSortable({ id });

  const style = {
    transform: CSS.Transform.toString(transform),
    transition,
    opacity: isDragging ? 0.5 : 1,
    cursor: 'grab',
    touchAction: 'none'
  };

  return (
    <button
      ref={setNodeRef}
      style={style}
      {...attributes}
      {...listeners}
      onClick={(e) => {
        onRemove();
      }}
      className="px-4 py-2 rounded-lg text-lg font-medium border-b-4 bg-white dark:bg-zinc-800 border-stone-200 dark:border-zinc-950 shadow-sm hover:bg-stone-50 dark:hover:bg-zinc-750 active:cursor-grabbing shrink-0"
    >
      {wordText}
    </button>
  );
}

export default function App() {
  const [user, setUser] = useState(null);
  const [activeTab, setActiveTab] = useState('studio');
  const [isDarkMode, setIsDarkMode] = useState(false);
  const [showAdvanced, setShowAdvanced] = useState(false);
  
  const [episodesList, setEpisodesList] = useState([]);
  const [activeEpisodeId, setActiveEpisodeId] = useState(null);
  const [activeEpisode, setActiveEpisode] = useState(null);
  
  const [isLoadingEpisodes, setIsLoadingEpisodes] = useState(true);
  const [isLoadingActiveEpisode, setIsLoadingActiveEpisode] = useState(false);

  const [progress, setProgress] = useState({ mastered: {}, quizAnswers: {}, quizGraded: {} });
  const [dictionary, setDictionary] = useState([]);
  
  const [topicInput, setTopicInput] = useState('');
  const [isGenerating, setIsGenerating] = useState(false);
  const [drillRevealed, setDrillRevealed] = useState({});
  const [searchTerm, setSearchTerm] = useState('');
  const [playingId, setPlayingId] = useState(null);
  const [geminiApiKey, setGeminiApiKey] = useState(() => localStorage.getItem('geminiApiKey') || '');

  const { isInstallable, installPWA } = usePWAInstall();

  const sensors = useSensors(
    useSensor(PointerSensor, {
      activationConstraint: {
        distance: 8,
      },
    }),
    useSensor(TouchSensor, {
      activationConstraint: {
        delay: 200,
        tolerance: 8,
      },
    })
  );

  // --- AI VOICE ASSISTANT SETUP ---
  const [helpContext, setHelpContext] = useState(null);
  
  // We will define this hook at the very bottom of the file
  const { 
    isActive: isAiActive, 
    isConnecting: isAiConnecting, 
    isSpeaking: isAiSpeaking, 
    startAssistant, 
    stopAssistant, 
    updateContext 
  } = useGeminiLiveAssistant();

  const openHelp = (contextData) => {
    setHelpContext(contextData);
    stopSpeak(); // Stop any reading/drills currently playing
    
    if (isAiActive || isAiConnecting) {
        // If already listening, just quietly swap the AI's context
        updateContext(contextData);
    } else {
        // Turn on mic and connect to WS
        startAssistant(contextData);
    }
  };

  const { handleSpeak, stopSpeak } = useGeminiTTS("You are a professional voice actor. Read exactly what is written. If English, use American accent. If Serbian, use Serbian accent. NEVER translate.");

  useEffect(() => {
    const unsub = onAuthStateChanged(auth, setUser);
    return () => unsub();
  }, []);

  // Sync Gemini API key from Firestore and keep local storage in sync as a cache for hooks
  useEffect(() => {
    if (!user) {
      setGeminiApiKey('');
      return;
    }

    const userDocRef = doc(db, 'artifacts', APP_ID, 'users', user.uid);
    const unsub = onSnapshot(userDocRef, async (docSnap) => {
      const localKey = localStorage.getItem('geminiApiKey');
      if (docSnap.exists()) {
        const data = docSnap.data();
        if (data.geminiApiKey) {
          setGeminiApiKey(data.geminiApiKey);
          localStorage.setItem('geminiApiKey', data.geminiApiKey);
        } else if (localKey) {
          await setDoc(userDocRef, { geminiApiKey: localKey }, { merge: true });
        }
      } else if (localKey) {
        await setDoc(userDocRef, { geminiApiKey: localKey }, { merge: true });
      }
    }, (err) => {
      console.error("User doc snapshot error:", err);
    });

    return () => unsub();
  }, [user]);

  const handleGoogleSignIn = async () => {
    const provider = new GoogleAuthProvider();
    try {
      await signInWithPopup(auth, provider);
    } catch (error) {
      console.error("Грешка при пријави:", error);
      alert("Није успела пријава: " + error.message);
    }
  };

  const handleSignOut = async () => {
    try {
      await signOut(auth);
    } catch (error) {
      console.error("Грешка при одјави:", error);
    }
  };

  // Fetch List of Episodes & Auto-select Latest
  useEffect(() => {
    if (!user) {
      setEpisodesList([]);
      setIsLoadingEpisodes(false);
      return;
    }
    
    setIsLoadingEpisodes(true);
    const epQuery = query(
      collection(db, 'artifacts', APP_ID, 'users', user.uid, 'episodes'),
      orderBy('timestamp', 'desc')
    );
    
    const unsub = onSnapshot(epQuery, (snapshot) => {
      const eps = snapshot.docs.map(doc => ({ 
        id: doc.id, 
        title: doc.data().title,
        timestamp: doc.data().timestamp 
      }));
      
      setEpisodesList(eps);
      setIsLoadingEpisodes(false);
      
      // If no episode is currently selected, auto-select the most recent one
      setActiveEpisodeId(prevId => {
        if (!prevId && eps.length > 0) {
          return eps[0].id;
        }
        return prevId;
      });
    }, (err) => {
      console.error("Error fetching episodes:", err);
      setIsLoadingEpisodes(false);
    });

    return () => unsub();
  }, [user]);

  useEffect(() => {
    const mediaQuery = window.matchMedia('(prefers-color-scheme: dark)');
    setIsDarkMode(mediaQuery.matches);
    const handler = (e) => setIsDarkMode(e.matches);
    mediaQuery.addEventListener('change', handler);
    return () => mediaQuery.removeEventListener('change', handler);
  }, []);

  useEffect(() => {
    if (isDarkMode) {
      document.documentElement.classList.add('dark');
    } else {
      document.documentElement.classList.remove('dark');
    }
  }, [isDarkMode]);

  // Fetch Active Episode Data & Progress
  useEffect(() => {
    if (!user || !activeEpisodeId) { 
      setActiveEpisode(null); 
      setIsLoadingActiveEpisode(false);
      return; 
    }
    
    setIsLoadingActiveEpisode(true);
    setDrillRevealed({}); 
    
    const unsubEp = onSnapshot(doc(db, 'artifacts', APP_ID, 'users', user.uid, 'episodes', activeEpisodeId), (snap) => {
      if (snap.exists()) setActiveEpisode({ id: snap.id, ...snap.data() });
      else setActiveEpisode(null);
      setIsLoadingActiveEpisode(false);
    }, (err) => {
      console.error("Error fetching active episode:", err);
      setIsLoadingActiveEpisode(false);
    });
    
    const unsubProg = onSnapshot(doc(db, 'artifacts', APP_ID, 'users', user.uid, 'progress', activeEpisodeId), (snap) => {
      if (snap.exists()) setProgress({ mastered: {}, quizAnswers: {}, quizGraded: {}, quizAttempts: {}, ...snap.data() });
      else setProgress({ mastered: {}, quizAnswers: {}, quizGraded: {}, quizAttempts: {} });
    }, (err) => {
      console.error("Error fetching progress:", err);
    });

    return () => { unsubEp(); unsubProg(); };
  }, [activeEpisodeId, user]);

  // Fetch Dictionary
  useEffect(() => {
    if (!user) return;
    return onSnapshot(doc(db, 'artifacts', APP_ID, 'users', user.uid, 'database', 'dictionary'), (snap) => {
      if (snap.exists()) setDictionary(snap.data().entries || []);
    }, (err) => {
      console.error("Error fetching dictionary:", err);
    });
  }, [user]);

  // --- SAFE STATE UPDATES ---
  const markDrillCompleted = async (dId) => {
    setDrillRevealed(prev => ({ ...prev, [dId]: true }));
    
    // Optimistic UI update
    setProgress(prev => ({
       ...prev,
       mastered: { ...(prev.mastered || {}), [dId]: true }
    }));

    // Perform network request safely outside the state updater
    if (user && activeEpisodeId) {
      try {
        await setDoc(doc(db, 'artifacts', APP_ID, 'users', user.uid, 'progress', activeEpisodeId), { 
          // Using dot notation/deep merge guarantees we only touch this specific drill 
          // even if the closure's state is momentarily stale.
          mastered: { [dId]: true } 
        }, { merge: true });
      } catch (err) {
        console.error("Error saving drill progress:", err);
      }
    }
  };

  const updateQuizState = async (qId, selectedIds, isCorrect = null, attemptText = null) => {
    // Calculate the next states outside the updater using the current component scope
    const nextAnswers = { ...progress.quizAnswers, [qId]: selectedIds };
    const nextAttempts = { ...(progress.quizAttempts || {}) };
    const nextGraded = { ...progress.quizGraded };
    
    if (isCorrect !== null) {
        nextGraded[qId] = isCorrect ? 'correct' : 'incorrect';
        if (!isCorrect && attemptText) {
            nextAttempts[qId] = attemptText;
        }
    } else if (nextGraded[qId] === 'incorrect') {
        delete nextGraded[qId];
    }

    setProgress(prev => ({
        ...prev,
        quizAnswers: nextAnswers,
        quizGraded: nextGraded,
        quizAttempts: nextAttempts
    }));
    
    if (user && activeEpisodeId) {
      try {
        await setDoc(doc(db, 'artifacts', APP_ID, 'users', user.uid, 'progress', activeEpisodeId), { 
            quizAnswers: nextAnswers, 
            quizGraded: nextGraded,
            quizAttempts: nextAttempts
        }, { merge: true });
      } catch (err) {
        console.error("Error saving quiz progress:", err);
      }
    }
  };

  const processJSON = async (rawText) => {
    try {
      let text = rawText.trim();
      text = text.replace(/^```json/i, '').replace(/^```/, '').replace(/```$/, '').trim();
      text = text.replace(/[\r\n]+/g, ' ');
      const data = JSON.parse(text);
      
      const newEpId = `ep_${Date.now()}`;
      const batch = writeBatch(db);
      
      batch.set(doc(db, 'artifacts', APP_ID, 'users', user.uid, 'episodes', newEpId), { ...data, timestamp: Date.now() });
      
      if (data.newLemmas && data.newLemmas.length > 0) {
        batch.set(doc(db, 'artifacts', APP_ID, 'users', user.uid, 'database', 'dictionary'), { 
          entries: [...data.newLemmas, ...dictionary] 
        }, { merge: true });
      }
      
      await batch.commit();
      setActiveEpisodeId(newEpId);
      setTopicInput('');
      setActiveTab('reading');
    } catch (e) {
      alert("Грешка при креирању лекције. Проверите JSON формат.");
      console.error(e);
    }
  };

  const buildPrompt = async () => {
    const finalTopic = topicInput.trim() || "Генериши лекцију по свом избору";
    const flatLexicon = dictionary.map(w => w.english).join(', ');
    
    let pastContext = '';
    
    try {
      // 1. Fetch exactly the last 10 episodes directly from Firestore
      const epQuery = query(
        collection(db, 'artifacts', APP_ID, 'users', user.uid, 'episodes'),
        orderBy('timestamp', 'desc'),
        limit(10)
      );
      
      const epSnapshot = await getDocs(epQuery);
      
      // Reverse so the oldest of the 10 is first, and the most recent is last (chronological order)
      const recentEpisodes = epSnapshot.docs.map(doc => ({ id: doc.id, ...doc.data() })).reverse();
      
      // 2. Fetch the corresponding user progress for these 10 episodes
      const progressPromises = recentEpisodes.map(ep => 
        getDoc(doc(db, 'artifacts', APP_ID, 'users', user.uid, 'progress', ep.id))
      );
      const progressSnaps = await Promise.all(progressPromises);
      
      // 3. Build the context string
      for (let i = 0; i < recentEpisodes.length; i++) {
        const ep = recentEpisodes[i];
        const progSnap = progressSnaps[i];
        const prog = progSnap.exists() ? progSnap.data() : {};
        
        let epContext = '';
        if (ep.title) epContext += `Lesson Title: ${ep.title}\n`;
        
        // Include the entire Dialog (English ONLY)
        if (ep.dialog && ep.dialog.length > 0) {
          epContext += `Dialog (English):\n${ep.dialog.map(d => `${d.speaker}: ${d.en}`).join('\n')}\n`;
        }
        
        // Include Drills (English ONLY)
        if (ep.drills && ep.drills.length > 0) {
          epContext += `Drills (English):\n${ep.drills.map(d => `- ${d.en}`).join('\n')}\n`;
        }
        
        // Include the Quiz (Target sentence, options/distractors, and graded result)
        if (ep.quiz && ep.quiz.length > 0) {
          let quizDetails = [];
          ep.quiz.forEach((q, qIdx) => {
            const qId = `q${qIdx}`;
            const status = prog.quizGraded?.[qId];
            
            let resultTxt = 'Not answered';
            if (status === 'correct') resultTxt = 'Correct';
            if (status === 'incorrect') {
              const wrongAttempt = prog.quizAttempts?.[qId] || "unknown sequence";
              resultTxt = `Incorrect. The user answered: "${wrongAttempt}"`;
            }
            
            const optionsStr = q.options ? q.options.join(', ') : '';
            const qType = q.type || 'translation';
            quizDetails.push(`- Type: ${qType} | Target: "${q.target}" | Options: [${optionsStr}] | Result: ${resultTxt}`);
          });
          if (quizDetails.length > 0) epContext += `Quiz Performance:\n${quizDetails.join('\n')}\n`;
        }
        
        if (epContext) pastContext += `\n--- Past Episode ---\n${epContext}`;
      }
    } catch (error) {
      console.error("Error building past context:", error);
    }

    const knownVocabBlock = flatLexicon ? `\nKNOWN VOCABULARY:\n[${flatLexicon}]\n` : '\nKNOWN VOCABULARY:\n[None yet, this is the first lesson.]\n';
    const pastContextBlock = pastContext ? `\nRECENT CONTEXT & PERFORMANCE (Last 10 lessons):\n${pastContext}\n` : '';
    
    return `SYSTEM INSTRUCTION:\n${SYSTEM_PROMPT}\n${knownVocabBlock}${pastContextBlock}\nUSER REQUEST:\n${finalTopic}\n\nOUTPUT FORMAT:\n${JSON_SCHEMA}`;
  };

  const handleExportPrompt = async () => {
    setIsGenerating(true);
    try {
      const promptText = await buildPrompt();
      const blob = new Blob([promptText], { type: 'text/plain' });
      const url = URL.createObjectURL(blob);
      const a = document.createElement('a');
      a.href = url;
      a.download = `Lekcija_Prompt_${Date.now()}.txt`;
      document.body.appendChild(a);
      a.click();
      document.body.removeChild(a);
      URL.revokeObjectURL(url);
    } catch (e) { alert("Greška: " + e.message); } 
    finally { setIsGenerating(false); }
  };

  const handleGenerate = async () => {
    if (!geminiApiKey) { alert("Унесите API кључ у напредним подешавањима."); return; }
    const key = geminiApiKey;
    
    setIsGenerating(true);
    try {
      const promptText = await buildPrompt();
      const res = await fetch(`https://generativelanguage.googleapis.com/v1beta/models/gemini-3.6-flash:generateContent?key=${key}`, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({
             contents: [{ parts: [{ text: promptText }] }],
             generationConfig: { responseMimeType: "application/json" }
          })
      });
      const data = await res.json();
      await processJSON(data.candidates[0].content.parts[0].text);
    } catch (err) { alert("Грешка: " + err.message); } 
    finally { setIsGenerating(false); }
  };

  const handleDeleteEpisode = async () => {
    if (!activeEpisodeId || !window.confirm("Да ли сте сигурни да желите да обришете ову лекцију?")) return;
    try {
      const batch = writeBatch(db);
      
      // 1. Delete the episode and its progress
      batch.delete(doc(db, 'artifacts', APP_ID, 'users', user.uid, 'episodes', activeEpisodeId));
      batch.delete(doc(db, 'artifacts', APP_ID, 'users', user.uid, 'progress', activeEpisodeId));
      
      // 2. Remove the vocabulary introduced in this lesson
      if (activeEpisode?.newLemmas && activeEpisode.newLemmas.length > 0) {
        const wordsToRemove = activeEpisode.newLemmas.map(l => l.english);
        const newDict = dictionary.filter(w => !wordsToRemove.includes(w.english));
        batch.set(doc(db, 'artifacts', APP_ID, 'users', user.uid, 'database', 'dictionary'), { 
          entries: newDict 
        }, { merge: true });
      }
      
      await batch.commit();

      const nextEp = episodesList.find(e => e.id !== activeEpisodeId);
      setActiveEpisodeId(nextEp ? nextEp.id : null);
      if (!nextEp) setActiveEpisode(null);
    } catch (e) { 
      alert("Грешка при брисању."); 
      console.error(e); 
    }
  };  

  const handlePlayAudio = (id, textObjects, onComplete = null) => {
    if (playingId === id) { stopSpeak(); setPlayingId(null); return; }
    setPlayingId(id);
    handleSpeak(textObjects, () => { setPlayingId(null); if (onComplete) onComplete(); }, () => setPlayingId(null));
  };

  const quizData = useMemo(() => {
    if (!activeEpisode?.quiz) return [];
    return activeEpisode.quiz.map((q, idx) => {
      const stableWordObjects = q.options.map((word, wIdx) => ({ 
        id: `q${idx}-w${wIdx}`, 
        text: cleanText(word) 
      }));
      const wordObjects = shuffleArray(stableWordObjects);
      return { ...q, id: `q${idx}`, cleanTarget: cleanText(q.target), wordObjects };
    });
  }, [activeEpisode?.quiz]);

  const handleQuizCheck = (q) => {
    const selectedIds = progress.quizAnswers[q.id] || [];
    const selectedText = selectedIds.map(id => q.wordObjects.find(w => w.id === id).text).join(' ');
    const isCorrect = selectedText === q.cleanTarget;
    
    // Pass the actual assembled text so we can log the mistake
    updateQuizState(q.id, selectedIds, isCorrect, selectedText);
    
    if (isCorrect) {
      handlePlayAudio(`quiz-${q.id}`, [{ text: q.target, voice: q.gender === 'M' ? 'Puck' : 'Leda' }]);
    } else if (isAiActive) {
      updateContext({
        tip: 'quiz_incorrect_attempt',
        ...q,
        userCurrentAnswer: selectedText,
        isIncorrect: true,
        lastWrongAttempt: selectedText,
        systemNotification: `Корисник је управо предао нетачан одговор на квизу: "${selectedText}". Тачан одговор је "${q.target}".`
      });
    }
  };

  const filteredDict = dictionary.filter(w => 
    w.english.toLowerCase().includes(searchTerm.toLowerCase()) || 
    w.serbian.toLowerCase().includes(searchTerm.toLowerCase())
  );

  // --- LOGIN SCREEN ---
  if (!user) {
    return (
      <div className={`min-h-screen flex items-center justify-center transition-colors duration-500 p-4 ${isDarkMode ? 'dark bg-zinc-950 text-zinc-300' : 'bg-stone-50 text-stone-900'}`}>
        <div className={`max-w-md w-full p-8 rounded-3xl shadow-lg border text-center ${isDarkMode ? 'bg-zinc-900 border-zinc-800' : 'bg-white border-stone-200'}`}>
          <div className="bg-blue-600 text-white p-4 rounded-2xl w-16 h-16 flex items-center justify-center mx-auto mb-6 shadow-lg shadow-blue-900/20">
            <Compass size={32} />
          </div>
          <h1 className={`text-3xl font-bold mb-3 tracking-tight ${isDarkMode ? 'text-zinc-100' : 'text-stone-900'}`}>Енглески за почетнике</h1>
          <p className={`mb-8 ${isDarkMode ? 'text-zinc-400' : 'text-stone-500'}`}>
            Пријавите се како бисте пратили свој напредак и сачували научене речи.
          </p>
          <button 
            onClick={handleGoogleSignIn}
            className="w-full bg-blue-600 hover:bg-blue-500 text-white font-bold text-lg py-4 rounded-2xl shadow-lg transition-all active:scale-95 flex items-center justify-center gap-3"
          >
            Пријави се преко Google-а
          </button>
        </div>
      </div>
    );
  }

  return (
    <div className={`min-h-screen font-sans transition-colors duration-500 flex flex-col ${isDarkMode ? 'dark bg-zinc-950 text-zinc-300' : 'bg-stone-50 text-stone-900'}`}>
      
      {/* 1. Top Navigation Bar */}
      <nav className={`py-4 px-6 border-b flex items-center justify-between sticky top-0 z-50 transition-colors duration-300 ${isDarkMode ? 'bg-zinc-900/90 border-zinc-800' : 'bg-white/90 border-stone-200 backdrop-blur-md'}`}>
        <div className="flex items-center gap-3">
          <div className="bg-blue-600 text-white p-2 rounded-xl shadow-lg shadow-blue-900/20">
            <Compass size={24} />
          </div>
          <span className={`text-xl font-bold tracking-tight ${isDarkMode ? 'text-zinc-100' : 'text-stone-800'}`}>Енглески за почетнике</span>
        </div>

        <div className="flex items-center gap-4">
          {activeEpisode && (
            <span className={`hidden sm:block text-xs font-bold px-3 py-1 rounded-full border ${isDarkMode ? 'border-zinc-700 bg-zinc-800 text-blue-400' : 'border-stone-200 bg-stone-50 text-blue-700'}`}>
              {activeEpisode.title || 'Активна лекција'}
            </span>
          )}
          
          {/* NEW PWA INSTALL BUTTON */}
          {isInstallable && (
            <button 
              onClick={installPWA}
              className="hidden sm:flex items-center gap-2 px-3 py-1.5 text-sm font-bold rounded-full bg-blue-600 text-white hover:bg-blue-500 transition-all active:scale-95 shadow-md shadow-blue-600/20"
            >
              <Smartphone size={16} /> Инсталирај
            </button>
          )}

          <button 
            onClick={handleSignOut}
            className={`text-xs font-bold px-3 py-1.5 rounded-full border transition-all active:scale-95 ${
              isDarkMode ? 'border-red-900/50 bg-red-900/20 text-red-400 hover:bg-red-900/40' : 'border-red-200 bg-red-50 text-red-600 hover:bg-red-100'
            }`}
          >
            Одјави се
          </button>

          <button 
            onClick={() => setIsDarkMode(!isDarkMode)}
            className={`p-2 rounded-full border transition-all active:scale-90 ${isDarkMode ? 'bg-zinc-800 border-zinc-700 text-blue-400' : 'bg-stone-50 border-stone-200 text-blue-600'}`}
          >
            {isDarkMode ? <Sun size={18} /> : <Moon size={18} />}
          </button>
        </div>
      </nav>

      {/* Main Content Wrapper */}
      <div className="max-w-4xl w-full mx-auto px-4 pt-8 flex-1 flex flex-col pb-24">
        
        {/* 2. Horizontal Navigation Tabs (Icons + Text) */}
        <div className={`flex overflow-x-auto no-scrollbar border-b mb-8 transition-colors ${isDarkMode ? 'border-zinc-800' : 'border-stone-200'}`}>
          {[
            { id: 'studio', label: 'Лекције', icon: MessageSquare },
            { id: 'reading', label: 'Читање', icon: BookOpen },
            { id: 'drills', label: 'Вежбе', icon: Layers },
            { id: 'quiz', label: 'Квиз', icon: CheckCircle },
            { id: 'dictionary', label: 'Речник', icon: Hash }
          ].map(tab => (
            <button 
              key={tab.id}
              onClick={() => { setActiveTab(tab.id); stopSpeak(); setPlayingId(null); }}
              className={`py-3 px-4 sm:px-6 text-sm sm:text-base font-semibold border-b-2 transition-all flex items-center gap-2 whitespace-nowrap ${
                activeTab === tab.id 
                  ? (isDarkMode ? 'border-blue-500 text-blue-400' : 'border-blue-600 text-blue-700') 
                  : (isDarkMode ? 'border-transparent text-zinc-400 hover:text-zinc-200' : 'border-transparent text-stone-500 hover:text-stone-700')
              }`}
            >
              <tab.icon size={18} /> <span className="hidden sm:inline">{tab.label}</span>
            </button>
          ))}
        </div>

        {/* 1. STUDIO TAB (Simplified Generation) */}
        {activeTab === 'studio' && (
          <div className="space-y-8 animate-in fade-in">

            <div className={`p-8 rounded-3xl shadow-sm border text-center ${isDarkMode ? 'bg-zinc-900 border-zinc-800' : 'bg-white border-stone-200'}`}>
              <h2 className={`text-3xl font-bold mb-4 ${isDarkMode ? 'text-zinc-100' : 'text-stone-900'}`}>Шта желите да учите данас?</h2>
              <p className={`mb-6 ${isDarkMode ? 'text-zinc-400' : 'text-stone-500'}`}>Напишите тему или само кликните на дугме за насумичну лекцију.</p>
              
              <textarea 
                value={topicInput} onChange={e => setTopicInput(e.target.value)} disabled={isGenerating}
                placeholder="Генериши лекцију по свом избору..." 
                className={`w-full max-w-xl mx-auto block p-4 rounded-2xl border-2 text-lg focus:outline-none focus:border-blue-500 min-h-[100px] mb-6 ${isDarkMode ? 'bg-zinc-950 border-zinc-700 text-zinc-100 placeholder-zinc-500' : 'bg-stone-50 border-stone-200 placeholder-stone-400'}`} 
              />
              
              <button 
                onClick={handleGenerate} disabled={isGenerating}
                className="bg-blue-600 hover:bg-blue-500 text-white font-bold text-xl py-4 px-10 rounded-2xl shadow-lg transition-all active:scale-95 disabled:opacity-50 flex items-center justify-center mx-auto gap-3"
              >
                {isGenerating ? <Loader2 className="animate-spin" /> : <Play fill="currentColor" />} Направи Лекцију
              </button>
            </div>

            {/* Past Episodes Selector */}
            <div className="mt-8">
              <h3 className={`text-sm font-bold uppercase tracking-widest mb-4 ${isDarkMode ? 'text-zinc-500' : 'text-stone-400'}`}>Претходне Лекције</h3>
              {isLoadingEpisodes ? (
                <div className="p-6 text-center text-stone-400 dark:text-zinc-500 flex items-center justify-center gap-2">
                  <Loader2 className="animate-spin text-blue-600 dark:text-blue-400" size={20} /> Учитавање лекција...
                </div>
              ) : episodesList.length > 0 ? (
                <div className="grid gap-3 sm:grid-cols-2">
                  {episodesList.map(ep => (
                    <button 
                      key={ep.id} onClick={() => setActiveEpisodeId(ep.id)}
                      className={`p-4 rounded-2xl border text-left font-bold text-lg transition-all ${activeEpisodeId === ep.id ? (isDarkMode ? 'bg-blue-900/30 border-blue-500 text-blue-400' : 'bg-blue-50 border-blue-300 text-blue-700') : (isDarkMode ? 'bg-zinc-900 border-zinc-800 hover:bg-zinc-800' : 'bg-white border-stone-200 hover:bg-stone-100')}`}
                    >
                      {ep.title}
                    </button>
                  ))}
                </div>
              ) : (
                <p className={`text-sm italic ${isDarkMode ? 'text-zinc-500' : 'text-stone-400'}`}>Још увек немате сачуваних лекција.</p>
              )}
            </div>

            {/* Advanced Admin Tools */}
            <div className={`mt-12 pt-8 border-t border-dashed ${isDarkMode ? 'border-zinc-800' : 'border-stone-300'}`}>
              <button onClick={() => setShowAdvanced(!showAdvanced)} className={`flex items-center gap-2 font-bold mx-auto transition-colors ${isDarkMode ? 'text-zinc-400 hover:text-zinc-200' : 'text-stone-400 hover:text-stone-600'}`}>
                <Settings size={18} /> Напредна / Техничка подешавања
              </button>
              {showAdvanced && (
                <div className={`mt-6 p-6 rounded-2xl border flex flex-col items-center gap-4 ${isDarkMode ? 'bg-zinc-900 border-zinc-800' : 'bg-stone-100 border-stone-200'}`}>
                  <div className="text-sm font-bold flex items-center gap-2">
                    <span>Статус API кључа:</span>
                    {geminiApiKey ? (
                      <span className="text-emerald-500 flex items-center gap-1"><Check size={16} /> Подешен (Firestore)</span>
                    ) : (
                      <span className="text-red-500">Није подешен</span>
                    )}
                  </div>
                  <div className="flex flex-wrap gap-4 justify-center">
                    <button onClick={async () => { 
                      const key = prompt("Унесите API кључ:"); 
                      if(key) {
                        try {
                          await setDoc(doc(db, 'artifacts', APP_ID, 'users', user.uid), { geminiApiKey: key }, { merge: true });
                        } catch (err) {
                          alert("Грешка при чувању кључа: " + err.message);
                        }
                      }
                    }} className={`px-4 py-2 rounded-lg text-sm font-bold transition-colors ${isDarkMode ? 'bg-zinc-800 text-zinc-200 border border-zinc-700 hover:bg-zinc-700' : 'bg-stone-800 text-white hover:bg-stone-700'}`}>
                      Постави API кључ
                    </button>
                    <button onClick={handleExportPrompt} className={`px-4 py-2 rounded-lg text-sm font-bold flex items-center gap-2 transition-colors ${isDarkMode ? 'bg-zinc-800 text-zinc-200 border border-zinc-700 hover:bg-zinc-700' : 'bg-stone-800 text-white hover:bg-stone-700'}`}>
                      <Download size={16}/> Извези промпт
                    </button>
                    <button onClick={async () => { try { const txt = await navigator.clipboard.readText(); processJSON(txt); } catch(e) { alert("Грешка при читању JSON-а"); } }} className={`px-4 py-2 rounded-lg text-sm font-bold flex items-center gap-2 transition-colors ${isDarkMode ? 'bg-zinc-800 text-zinc-200 border border-zinc-700 hover:bg-zinc-700' : 'bg-stone-800 text-white hover:bg-stone-700'}`}>
                      <ClipboardPaste size={16}/> Налепи JSON
                    </button>
                    {activeEpisodeId && (
                      <button onClick={handleDeleteEpisode} className={`px-4 py-2 rounded-lg text-sm font-bold flex items-center gap-2 transition-colors ${isDarkMode ? 'bg-red-950/40 text-red-400 border border-red-800/60 hover:bg-red-900/50' : 'bg-red-900/30 text-red-500 border border-red-900 hover:bg-red-900/50'}`}>
                        <Trash2 size={16}/> Обриши лекцију
                      </button>
                    )}
                  </div>
                </div>
              )}
            </div>
          </div>
        )}

        {/* 2. READING TAB */}
        {activeTab === 'reading' && (
          isLoadingActiveEpisode ? (
            <div className="py-16 text-center text-stone-500 dark:text-zinc-400">
              <Loader2 className="animate-spin mx-auto mb-4 text-blue-600 dark:text-blue-400" size={36} />
              <p className="text-lg font-medium">Учитавање лекције...</p>
            </div>
          ) : activeEpisode ? (
            <div className="space-y-8 animate-in fade-in">
               <header className="mb-8">
                  <h2 className={`text-3xl font-bold mb-2 ${isDarkMode ? 'text-zinc-100' : 'text-stone-900'}`}>{activeEpisode.title}</h2>
                  <p className={`text-lg ${isDarkMode ? 'text-zinc-400' : 'text-stone-500'}`}>{activeEpisode.tutorIntroduction}</p>
               </header>

               {/* Dialog */}
               <section className={`p-6 md:p-8 rounded-3xl shadow-sm border ${isDarkMode ? 'bg-zinc-900 border-zinc-800' : 'bg-white border-stone-200'}`}>
                  <div className={`flex items-center justify-between mb-8 border-b pb-4 ${isDarkMode ? 'border-zinc-800' : 'border-stone-100'}`}>
                    <h2 className="text-2xl font-bold flex items-center gap-2"><MessageCircle className="text-blue-600 dark:text-blue-400"/> Дијалог</h2>
                    <div className="flex gap-2">
                      <button 
                        onClick={() => openHelp({ tip: 'full_dialog', dialog: activeEpisode.dialog })} 
                        className={`p-3 rounded-full transition-all ${isDarkMode ? 'bg-zinc-800 text-blue-400 hover:bg-zinc-700' : 'bg-blue-50 text-blue-600 hover:bg-blue-100'}`}
                        title="Питај АИ о овом дијалогу"
                      >
                        <HelpCircle size={20} />
                      </button>
                      <button 
                        onClick={() => handlePlayAudio('dialog-full', activeEpisode.dialog.map(l => ({ text: l.en, voice: l.gender === 'M' ? 'Puck' : 'Leda' })))} 
                        className={`p-3 rounded-full transition-colors ${playingId === 'dialog-full' ? (isDarkMode ? 'bg-blue-950 text-blue-400 border border-blue-800' : 'bg-blue-100 text-blue-600') : (isDarkMode ? 'bg-zinc-800 text-zinc-300 hover:bg-zinc-700' : 'bg-stone-100 text-stone-600 hover:bg-stone-200')}`}
                      >
                        {playingId === 'dialog-full' ? <Pause size={20} /> : <Play size={20} fill="currentColor" />}
                      </button>
                    </div>
                  </div>
                  <div className="space-y-6">
                    {activeEpisode.dialog?.map((line, idx) => {
                      const isRight = idx % 2 !== 0;
                      return (
                        <div key={idx} className={`flex flex-col ${isRight ? 'items-end' : 'items-start'}`}>
                          <div className={`text-xs font-bold mb-1 opacity-60 px-2 ${isDarkMode ? 'text-zinc-400' : 'text-stone-600'}`}>{line.speaker}</div>
                          <div className={`max-w-[85%] p-4 rounded-2xl ${
                            isRight 
                              ? (isDarkMode ? 'bg-blue-950/80 text-blue-100 border border-blue-800/50 rounded-tr-sm' : 'bg-blue-100 text-blue-900 rounded-tr-sm') 
                              : (isDarkMode ? 'bg-zinc-800 text-zinc-100 border border-zinc-700/50 rounded-tl-sm' : 'bg-stone-100 text-stone-800 rounded-tl-sm')
                          }`}>
                            <p className="text-xl font-medium mb-1">{line.en}</p>
                            <p className={`text-sm italic ${isRight ? (isDarkMode ? 'text-blue-300/80' : 'opacity-70') : (isDarkMode ? 'text-zinc-400' : 'opacity-70')}`}>{line.sr}</p>
                          </div>
                        </div>
                      )
                    })}
                  </div>
               </section>

               {/* Grammar */}
               <section className={`p-6 md:p-8 rounded-3xl shadow-sm border ${isDarkMode ? 'bg-zinc-900 border-zinc-800' : 'bg-white border-stone-200'}`}>
                  <div className={`flex items-center justify-between mb-6 border-b pb-4 ${isDarkMode ? 'border-zinc-800' : 'border-stone-100'}`}>
                    <h2 className="text-2xl font-bold flex items-center gap-2"><Lightbulb className="text-amber-500"/> Објашњења</h2>
                    <button 
                      onClick={() => openHelp({ tip: 'full_grammar', grammar: activeEpisode.grammar })} 
                      className={`p-3 rounded-full transition-all ${isDarkMode ? 'bg-zinc-800 text-blue-400 hover:bg-zinc-700' : 'bg-blue-50 text-blue-600 hover:bg-blue-100'}`}
                      title="Питај АИ о граматици"
                    >
                      <HelpCircle size={20} />
                    </button>
                  </div>
                  <div className="space-y-6">
                    {activeEpisode.grammar?.map((item, idx) => (
                      <div key={idx}>
                        <span className={`font-bold block text-lg mb-1 ${isDarkMode ? 'text-blue-400' : 'text-blue-600'}`}>{item.title}</span> 
                        <p className={`text-lg ${isDarkMode ? 'text-zinc-200' : 'text-stone-800'}`}>{item.explanation}</p>
                      </div>
                    ))}
                  </div>
               </section>
            </div>
          ) : (
            <div className={`p-12 rounded-3xl border text-center ${isDarkMode ? 'bg-zinc-900 border-zinc-800' : 'bg-white border-stone-200'}`}>
              <BookOpen className="mx-auto mb-4 text-stone-400 dark:text-zinc-600" size={48} />
              <h3 className={`text-xl font-bold mb-2 ${isDarkMode ? 'text-zinc-200' : 'text-stone-800'}`}>Нема изабране лекције</h3>
              <p className={`mb-6 ${isDarkMode ? 'text-zinc-400' : 'text-stone-500'}`}>Изаберите или креирајте лекцију на картици "Лекције".</p>
              <button onClick={() => setActiveTab('studio')} className="px-6 py-3 rounded-xl font-bold bg-blue-600 text-white hover:bg-blue-500 transition-all active:scale-95">
                Иди на Лекције
              </button>
            </div>
          )
        )}

        {/* 3. DRILLS TAB */}
        {activeTab === 'drills' && (
          isLoadingActiveEpisode ? (
            <div className="py-16 text-center text-stone-500 dark:text-zinc-400">
              <Loader2 className="animate-spin mx-auto mb-4 text-blue-600 dark:text-blue-400" size={36} />
              <p className="text-lg font-medium">Учитавање вежби...</p>
            </div>
          ) : activeEpisode ? (
            <div className="space-y-6 animate-in fade-in">
              <header className="mb-6">
                <h2 className={`text-3xl font-bold mb-2 ${isDarkMode ? 'text-zinc-100' : 'text-stone-900'}`}>Вежбе</h2>
                  <p className={`text-lg ${isDarkMode ? 'text-zinc-400' : 'text-stone-500'}`}>
                    Слушајте и понављајте. (Енглески {'->'} Српски {'->'} Енглески)
                  </p>
              </header>
              
              <div className="space-y-4">
                {activeEpisode.drills?.map((drill, idx) => {
                  const dId = `drill_${idx}`;
                  const isMastered = progress.mastered[dId];
                  const isRevealed = drillRevealed[dId] || isMastered;
                  const v = drill.gender === 'M' ? 'Puck' : 'Leda';

                  return (
                    <div key={dId} className={`rounded-2xl p-5 border flex items-center justify-between gap-4 transition-all ${isDarkMode ? 'bg-zinc-900 border-zinc-800' : 'bg-white border-stone-200'}`}>
                      <div className="flex items-start gap-4 flex-1">
                        <div className={`mt-1 flex items-center justify-center w-6 h-6 rounded-full border shrink-0 ${
                          isMastered 
                            ? (isDarkMode ? 'bg-blue-950 border-blue-500 text-blue-400' : 'bg-blue-100 border-blue-500 text-blue-600') 
                            : (isDarkMode ? 'border-zinc-700 text-transparent' : 'border-stone-300 text-transparent')
                        }`}>
                          <Check size={14} strokeWidth={isMastered ? 3 : 2} />
                        </div>
                        <div className="flex-1">
                          {!isRevealed ? (
                            <button 
                              onClick={() => setDrillRevealed(prev => ({...prev, [dId]: true}))} 
                              className={`px-4 py-2 rounded-xl text-sm font-bold flex items-center gap-2 transition-colors ${
                                isDarkMode 
                                  ? 'bg-blue-950/60 text-blue-400 border border-blue-800/50 hover:bg-blue-900/60' 
                                  : 'bg-blue-50 text-blue-600 hover:bg-blue-100'
                              }`}
                            >
                              <Eye size={16} /> Прикажи текст
                            </button>
                          ) : (
                            <div>
                              <p className={`font-medium text-xl mb-1 ${isDarkMode ? 'text-zinc-100' : 'text-stone-900'}`}>{drill.en}</p>
                              <p className={`italic text-sm ${isDarkMode ? 'text-zinc-400' : 'opacity-60'}`}>{drill.sr}</p>
                            </div>
                          )}
                        </div>
                      </div>
                      
                      {/* Play and Help Buttons Wrapper */}
                      <div className="flex gap-2 shrink-0">
                        <button 
                          onClick={() => openHelp({ tip: 'drill', ...drill })}
                          className={`p-4 rounded-full border transition-all ${isDarkMode ? 'bg-zinc-800 text-blue-400 border-zinc-700 hover:bg-zinc-700' : 'bg-blue-50 text-blue-600 border-blue-100 hover:bg-blue-100'}`}
                        >
                          <HelpCircle size={20} />
                        </button>
                        <button 
                          onClick={() => handlePlayAudio(dId, [{ text: drill.en, voice: v }, { text: drill.sr, voice: v }, { text: drill.en, voice: v }], () => markDrillCompleted(dId))}
                          className={`p-4 rounded-full border transition-all ${
                            playingId === dId 
                              ? (isDarkMode ? 'bg-blue-950 text-blue-400 border-blue-800' : 'bg-blue-100 text-blue-600 border-blue-200') 
                              : (isDarkMode ? 'bg-zinc-800 text-zinc-300 border-zinc-700 hover:bg-zinc-700' : 'bg-stone-50 text-stone-600 hover:bg-stone-100')
                          }`}
                        >
                          {playingId === dId ? <Pause size={20} /> : <Volume2 size={20} />}
                        </button>
                      </div>
                    </div>
                  );
                })}
              </div>
            </div>
          ) : (
            <div className={`p-12 rounded-3xl border text-center ${isDarkMode ? 'bg-zinc-900 border-zinc-800' : 'bg-white border-stone-200'}`}>
              <Layers className="mx-auto mb-4 text-stone-400 dark:text-zinc-600" size={48} />
              <h3 className={`text-xl font-bold mb-2 ${isDarkMode ? 'text-zinc-200' : 'text-stone-800'}`}>Нема изабране лекције</h3>
              <p className={`mb-6 ${isDarkMode ? 'text-zinc-400' : 'text-stone-500'}`}>Изаберите или креирајте лекцију на картици "Лекције".</p>
              <button onClick={() => setActiveTab('studio')} className="px-6 py-3 rounded-xl font-bold bg-blue-600 text-white hover:bg-blue-500 transition-all active:scale-95">
                Иди на Лекције
              </button>
            </div>
          )
        )}

        {/* 4. QUIZ TAB */}
        {activeTab === 'quiz' && (
          isLoadingActiveEpisode ? (
            <div className="py-16 text-center text-stone-500 dark:text-zinc-400">
              <Loader2 className="animate-spin mx-auto mb-4 text-blue-600 dark:text-blue-400" size={36} />
              <p className="text-lg font-medium">Учитавање квиза...</p>
            </div>
          ) : activeEpisode ? (
            <div className="space-y-10 animate-in fade-in">
              <header className="mb-6">
                <h2 className={`text-3xl font-bold mb-2 ${isDarkMode ? 'text-zinc-100' : 'text-stone-900'}`}>Квиз</h2>
                <p className={`text-lg ${isDarkMode ? 'text-zinc-400' : 'text-stone-500'}`}>Сложите речи у реченицу.</p>
              </header>

             {quizData.map((q, idx) => {
                const status = progress.quizGraded[q.id]; 
                const selectedWordIds = progress.quizAnswers[q.id] || [];
                const availableWords = q.wordObjects.filter(w => !selectedWordIds.includes(w.id));
                
                // Figure out exactly what string the user has built so far
                const currentAttemptText = selectedWordIds
                  .map(id => q.wordObjects.find(w => w.id === id)?.text)
                  .filter(Boolean).join(' ');

                const selectWord = (wId) => {
                  if (status === 'correct') return;
                  updateQuizState(q.id, [...selectedWordIds, wId]);
                };
                
                const deselectWord = (wId) => {
                  if (status === 'correct') return;
                  updateQuizState(q.id, selectedWordIds.filter(id => id !== wId));
                };

                const handleDragEnd = (event) => {
                  const { active, over } = event;
                  if (!over || active.id === over.id) return;

                  const oldIndex = selectedWordIds.indexOf(active.id);
                  const newIndex = selectedWordIds.indexOf(over.id);
                  const newArray = arrayMove(selectedWordIds, oldIndex, newIndex);
                  updateQuizState(q.id, newArray);
                };

                return (
                  <div key={q.id} className={`p-6 rounded-3xl border shadow-sm ${status === 'correct' ? (isDarkMode ? 'bg-emerald-950/20 border-emerald-500/50' : 'bg-emerald-50 border-emerald-200') : status === 'incorrect' ? (isDarkMode ? 'bg-red-950/20 border-red-500/50' : 'bg-red-50 border-red-200') : (isDarkMode ? 'bg-zinc-900 border-zinc-800' : 'bg-white border-stone-200')}`}>
                    <div className="mb-6 flex items-center justify-between">
                      <div className="flex items-center gap-3">
                        <span className={`text-xl font-medium ${isDarkMode ? 'text-zinc-500' : 'opacity-40'}`}>{idx + 1}.</span>
                        {(!q.type || q.type === 'translation') ? (
                          <span className={`text-xl font-medium ${isDarkMode ? 'text-zinc-100' : 'text-stone-900'}`}>{q.prompt}</span>
                        ) : (
                          <button 
                            onClick={() => handlePlayAudio(`quiz-listen-${q.id}`, [{ text: q.target, voice: q.gender === 'M' ? 'Puck' : 'Leda' }])}
                            className={`flex items-center gap-2 px-4 py-2 rounded-xl font-bold transition-all active:scale-95 ${
                              playingId === `quiz-listen-${q.id}` 
                                ? 'bg-blue-600 text-white' 
                                : (isDarkMode ? 'bg-blue-950/50 text-blue-400 border border-blue-800/60 hover:bg-blue-900/60' : 'bg-blue-100 text-blue-700 hover:bg-blue-200')
                            }`}
                          >
                            {playingId === `quiz-listen-${q.id}` ? <Pause size={20} /> : <Volume2 size={20} />}
                            {q.prompt || "Слушајте и сложите реченицу"}
                          </button>
                        )}
                      </div>
                      <button 
                        onClick={() => openHelp({ 
                          tip: 'quiz', 
                          ...q, 
                          userCurrentAnswer: currentAttemptText || "Ништа још није унето.",
                          status: status,
                          isGraded: progress.quizGraded[q.id] || null,
                          lastWrongAttempt: progress.quizAttempts?.[q.id] || null
                        })} 
                        className={`p-2 rounded-full transition-all hover:scale-110 ${isDarkMode ? 'text-blue-400 bg-blue-950/40 hover:bg-blue-900/50' : 'text-blue-600 bg-blue-50 hover:bg-blue-100'}`}
                      >
                        <HelpCircle size={20} />
                      </button>
                    </div>
                    {status === 'correct' ? (
                      <div className={`p-4 rounded-xl border mb-6 ${isDarkMode ? 'bg-emerald-950/60 border-emerald-800/80' : 'bg-emerald-100/50 border-emerald-300'}`}>
                         <p className="text-2xl font-medium text-emerald-700 dark:text-emerald-400">{q.target}</p>
                      </div>
                    ) : (
                      <DndContext sensors={sensors} collisionDetection={closestCenter} onDragEnd={handleDragEnd}>
                        <SortableContext items={selectedWordIds} strategy={horizontalListSortingStrategy}>
                          <div className={`min-h-[4rem] p-3 rounded-xl border-2 border-dashed flex flex-wrap content-start gap-2 mb-6 ${isDarkMode ? 'border-zinc-700 bg-zinc-950/50' : 'border-stone-300 bg-stone-50/50'}`}>
                            {selectedWordIds.length === 0 && <span className={`m-auto text-sm ${isDarkMode ? 'text-zinc-500' : 'opacity-50'}`}>Кликните на речи испод...</span>}
                            {selectedWordIds.map(id => {
                              const wObj = q.wordObjects.find(w => w.id === id);
                              return wObj && (
                                <SortableWordTile
                                  key={id}
                                  id={id}
                                  wordText={wObj.text}
                                  onRemove={() => deselectWord(id)}
                                />
                              );
                            })}
                          </div>
                        </SortableContext>
                      </DndContext>
                    )}

                    {!status || status === 'incorrect' ? (
                      <div className="flex flex-wrap gap-2 mb-6 min-h-[3rem]">
                        {availableWords.map(wObj => (
                          <button 
                            key={wObj.id} 
                            onClick={() => selectWord(wObj.id)} 
                            className={`px-4 py-2 rounded-lg text-lg font-medium border-b-4 shadow-sm active:scale-95 transition-all ${
                              isDarkMode 
                                ? 'bg-zinc-800 text-zinc-100 border-zinc-950 hover:bg-zinc-750' 
                                : 'bg-white text-stone-900 border-stone-300'
                            }`}
                          >
                            {wObj.text}
                          </button>
                        ))}
                      </div>
                    ) : (
                      <div className="min-h-[3rem] mb-6 flex items-center text-emerald-600 dark:text-emerald-400 font-bold text-lg"><CheckCircle className="mr-2"/> Одлично!</div>
                    )}

                    <div className={`flex justify-end border-t pt-4 ${isDarkMode ? 'border-zinc-800' : 'border-stone-100'}`}>
                      {status === 'incorrect' && <p className="mr-auto my-auto font-bold text-red-500 dark:text-red-400">Није тачно. Покушајте поново.</p>}
                      {status !== 'correct' ? (
                        <button onClick={() => handleQuizCheck(q)} disabled={selectedWordIds.length === 0} className="px-6 py-3 rounded-xl font-bold bg-blue-600 text-white disabled:opacity-50 hover:bg-blue-500 transition-all active:scale-95">Провери</button>
                      ) : (
                        <button 
                          onClick={() => handlePlayAudio(`quiz-rev-${q.id}`, [{ text: q.target, voice: q.gender === 'M' ? 'Puck' : 'Leda' }])} 
                          className={`px-6 py-3 rounded-xl font-bold flex items-center gap-2 transition-all ${
                            isDarkMode 
                              ? 'bg-emerald-950/80 text-emerald-400 border border-emerald-800 hover:bg-emerald-900/80' 
                              : 'bg-emerald-100 text-emerald-700'
                          }`}
                        >
                          <Volume2 size={20}/> Слушај поново
                        </button>
                      )}
                    </div>
                  </div>
                );
              })}
            </div>
          ) : (
            <div className={`p-12 rounded-3xl border text-center ${isDarkMode ? 'bg-zinc-900 border-zinc-800' : 'bg-white border-stone-200'}`}>
              <CheckCircle className="mx-auto mb-4 text-stone-400 dark:text-zinc-600" size={48} />
              <h3 className={`text-xl font-bold mb-2 ${isDarkMode ? 'text-zinc-200' : 'text-stone-800'}`}>Нема изабране лекције</h3>
              <p className={`mb-6 ${isDarkMode ? 'text-zinc-400' : 'text-stone-500'}`}>Изаберите или креирајте лекцију на картици "Лекције".</p>
              <button onClick={() => setActiveTab('studio')} className="px-6 py-3 rounded-xl font-bold bg-blue-600 text-white hover:bg-blue-500 transition-all active:scale-95">
                Иди на Лекције
              </button>
            </div>
          )
        )}

        {/* 5. DICTIONARY TAB */}
        {activeTab === 'dictionary' && (
          <div className="space-y-6 animate-in fade-in">
            <header className="mb-8 flex flex-col md:flex-row md:items-end justify-between gap-4">
              <div>
                <h2 className={`text-3xl font-bold mb-2 ${isDarkMode ? 'text-zinc-100' : 'text-stone-900'}`}>Речник</h2>
                <p className={`text-lg ${isDarkMode ? 'text-zinc-400' : 'text-stone-500'}`}>{dictionary.length} научених речи.</p>
              </div>
              <div className="relative w-full md:max-w-xs">
                <Search className={`absolute left-4 top-1/2 -translate-y-1/2 ${isDarkMode ? 'text-zinc-500' : 'text-stone-400'}`} size={18} />
                <input 
                  type="text" 
                  placeholder="Претражи..." 
                  value={searchTerm} 
                  onChange={e => setSearchTerm(e.target.value)} 
                  className={`w-full pl-11 pr-4 py-3 rounded-xl border-2 focus:outline-none focus:border-blue-500 transition-all ${
                    isDarkMode 
                      ? 'bg-zinc-900 border-zinc-700 text-zinc-100 placeholder-zinc-500' 
                      : 'bg-white border-stone-200 text-stone-900 placeholder-stone-400'
                  }`} 
                />
              </div>
            </header>

            <div className="grid grid-cols-1 sm:grid-cols-2 lg:grid-cols-3 gap-4">
              {filteredDict.map((item, idx) => (
                <div key={idx} className={`p-5 rounded-2xl border flex flex-col justify-between ${isDarkMode ? 'bg-zinc-900 border-zinc-800' : 'bg-white border-stone-200'}`}>
                  <div>
                    <div className="flex items-start justify-between mb-2">
                      <div className="flex items-center gap-2">
                        <button 
                          onClick={() => handlePlayAudio(`dict-${idx}`, [{ text: item.english, voice: 'Leda' }])} 
                          className={`p-1.5 rounded-full transition-colors ${
                            isDarkMode ? 'bg-zinc-800 text-blue-400 hover:bg-zinc-700' : 'bg-blue-50 text-blue-600 hover:bg-blue-100'
                          }`}
                        >
                          <Volume2 size={16}/>
                        </button>
                        <h3 className={`text-xl font-medium ${isDarkMode ? 'text-zinc-100' : 'text-stone-900'}`}>{item.english}</h3>
                      </div>
                      {item.pos && (
                        <span className={`text-[9px] uppercase font-bold px-2 py-1 rounded border ${
                          isDarkMode 
                            ? 'bg-blue-950/60 border-blue-800/80 text-blue-300' 
                            : 'bg-blue-50 border-blue-200 text-blue-600'
                        }`}>
                          {item.pos}
                        </span>
                      )}
                    </div>
                    <p className={`text-xs font-mono italic mb-4 ml-8 ${isDarkMode ? 'text-blue-400/80' : 'text-blue-600/70'}`}>/{item.pronunciation}/</p>
                  </div>
                  <div className={`pt-3 border-t flex items-start gap-2 ${isDarkMode ? 'border-zinc-800' : 'border-stone-100'}`}>
                    <Tag className={`w-3.5 h-3.5 mt-0.5 ${isDarkMode ? 'text-zinc-500' : 'text-stone-400'}`} />
                    <p className={`text-sm font-medium ${isDarkMode ? 'text-zinc-300' : 'text-stone-700'}`}>{item.serbian}</p>
                  </div>
                </div>
              ))}
            </div>
          </div>
        )}

        {/* --- FLOATING VOICE ASSISTANT --- */}
        {(isAiActive || isAiConnecting) && (
          <div className={`fixed bottom-6 right-6 z-[100] flex items-center gap-4 p-4 rounded-[2rem] shadow-2xl transition-all animate-in slide-in-from-bottom-10 border ${isDarkMode ? 'bg-zinc-900/90 border-zinc-700 backdrop-blur-md' : 'bg-white/90 border-stone-200 backdrop-blur-md'}`}>
            <div className="flex items-center justify-center w-14 h-14 rounded-full bg-blue-600 text-white relative shadow-lg shadow-blue-900/20">
              {isAiConnecting ? (
                <Loader2 className="animate-spin" size={26} />
              ) : isAiSpeaking ? (
                <AudioLines className="animate-pulse" size={26} />
              ) : (
                <Mic className="animate-pulse opacity-80" size={26} />
              )}
              {/* Status Indicator Dot */}
              <div className={`absolute top-0 right-0 w-3.5 h-3.5 rounded-full border-2 ${isDarkMode ? 'border-zinc-900' : 'border-white'} ${isAiConnecting ? 'bg-amber-400' : 'bg-emerald-500'}`} />
            </div>

            <div className="flex flex-col pr-2 min-w-[120px]">
              <span className={`font-bold text-sm ${isDarkMode ? 'text-zinc-100' : 'text-stone-800'}`}>АИ Асистент</span>
              <span className={`text-xs ${isDarkMode ? 'text-zinc-400' : 'text-stone-500'}`}>
                {isAiConnecting ? 'Повезивање...' : isAiSpeaking ? 'Говори...' : 'Слуша...'}
              </span>
            </div>

            <button 
              onClick={stopAssistant}
              className={`p-3 rounded-full transition-colors ${isDarkMode ? 'hover:bg-zinc-800 text-zinc-400 hover:text-white' : 'hover:bg-stone-100 text-stone-400 hover:text-stone-800'}`}
              title="Угаси асистента"
            >
              <X size={20} />
            </button>
          </div>
        )}

      </div>
    </div>
  );
}