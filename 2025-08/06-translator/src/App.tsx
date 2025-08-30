import { useState, useRef, useEffect } from 'react'
import { GoogleGenerativeAI, SchemaType } from '@google/generative-ai'
import { useAppStore } from './store'

type LanguagePair = 'ja-en' | 'en-ru' | 'ru-ja'

const languageNames: { [key: string]: string } = {
  ja: 'Japanese',
  en: 'English',
  ru: 'Russian',
}

const languageFlags: { [key: string]: string } = {
  ja: '🇯🇵',
  en: '🇺🇸',
  ru: '🇷🇺',
}

function App() {
  // Zustand store
  const {
    apiKey,
    languagePair,
    model,
    showSettings,
    history,
    error,
    setApiKey,
    setLanguagePair,
    setModel,
    setShowSettings,
    setError,
    addHistoryItem,
    clearHistory,
  } = useAppStore()

  // Local component state
  const [isRecording, setIsRecording] = useState(false)
  const [isTranslating, setIsTranslating] = useState(false)
  const [lastAudioBlob, setLastAudioBlob] = useState<Blob | null>(null)

  const [timer, setTimer] = useState('0:00')

  const mediaRecorderRef = useRef<MediaRecorder | null>(null)
  const streamRef = useRef<MediaStream | null>(null)
  const timerIntervalRef = useRef<number | null>(null)
  const recordingStartTimeRef = useRef<number | null>(null)
  const historyEndRef = useRef<HTMLDivElement>(null)

  useEffect(() => {
    // Check if we need to show settings on first load
    if (!apiKey) {
      setShowSettings(true)
    }

    return () => {
      if (timerIntervalRef.current) clearInterval(timerIntervalRef.current)
    }
  }, [])

  useEffect(() => {
    historyEndRef.current?.scrollIntoView({ behavior: 'smooth' })
  }, [history])

  const saveSettings = () => {
    if (apiKey.trim()) {
      setShowSettings(false)
      setError('')
    }
  }



  const cycleLanguagePair = () => {
    const pairs: LanguagePair[] = ['ja-en', 'en-ru', 'ru-ja']
    const currentIndex = pairs.indexOf(languagePair)
    const nextIndex = (currentIndex + 1) % pairs.length
    setLanguagePair(pairs[nextIndex])
  }

  const startRecording = async () => {
    if (!apiKey) {
      setShowSettings(true)
      return
    }

    try {
      setError('')
      setLastAudioBlob(null) // Clear previous audio when starting new recording
      const stream = await navigator.mediaDevices.getUserMedia({ audio: true })
      streamRef.current = stream

      const mediaRecorder = new MediaRecorder(stream, { mimeType: 'audio/webm' })
      mediaRecorderRef.current = mediaRecorder

      const audioChunks: Blob[] = []
      mediaRecorder.addEventListener('dataavailable', event => {
        audioChunks.push(event.data)
      })

      mediaRecorder.addEventListener('stop', async () => {
        const audioBlob = new Blob(audioChunks, { type: 'audio/webm' })
        setLastAudioBlob(audioBlob)
        translateAudio(audioBlob)
      })

      mediaRecorder.start()
      setIsRecording(true)
      recordingStartTimeRef.current = Date.now()
      timerIntervalRef.current = window.setInterval(updateTimer, 1000)

    } catch (err) {
      console.error('Mic error:', err)
      setError('Could not start recording. Please allow microphone access.')
    }
  }

  const stopRecording = () => {
    if (mediaRecorderRef.current) {
      mediaRecorderRef.current.stop()
      streamRef.current?.getTracks().forEach(track => track.stop())
      setIsRecording(false)
      if (timerIntervalRef.current) clearInterval(timerIntervalRef.current)
      setTimer('0:00')
      recordingStartTimeRef.current = null
    }
  }

  const updateTimer = () => {
    if (recordingStartTimeRef.current) {
      const seconds = Math.floor((Date.now() - recordingStartTimeRef.current) / 1000)
      const min = Math.floor(seconds / 60)
      const sec = (seconds % 60).toString().padStart(2, '0')
      setTimer(`${min}:${sec}`)
    }
  }

  const fileToGenerativePart = async (file: File) => {
    const base64EncodedDataPromise = new Promise<string>((resolve) => {
      const reader = new FileReader();
      reader.onloadend = () => resolve((reader.result as string).split(',')[1]);
      reader.readAsDataURL(file);
    });
    return {
      inlineData: { data: await base64EncodedDataPromise, mimeType: file.type },
    };
  }

  const translateAudio = async (audioBlob: Blob) => {
    try {
      setIsTranslating(true)
      setError('') // Clear previous errors

      const ai = new GoogleGenerativeAI(apiKey)
      const aiModel = ai.getGenerativeModel({
        model,
        generationConfig: {
          responseMimeType: 'application/json',
          responseSchema: {
            type: SchemaType.OBJECT,
            properties: {
              transcription: { type: SchemaType.STRING },
              translation: { type: SchemaType.STRING },
            },
            required: ['transcription', 'translation'],
          },
        },
      })

      const [sourceLang, targetLang] = languagePair.split('-')

      const prompt = `You are an expert translator for a conversation between ${languageNames[sourceLang]} and ${languageNames[targetLang]}. Listen to the audio, transcribe exactly what was said, then translate it to the other language. If the input is in ${languageNames[sourceLang]}, translate to ${languageNames[targetLang]}. If the input is in ${languageNames[targetLang]}, translate to ${languageNames[sourceLang]}. Provide your response in the requested JSON format.`

      const audioFile = new File([audioBlob], "audio.webm", { type: "audio/webm" });
      const audioPart = await fileToGenerativePart(audioFile)

      const result = await aiModel.generateContent([prompt, audioPart])
      const responseText = result.response.text()
      const responseJson = JSON.parse(responseText)

      addHistoryItem({
        transcription: responseJson.transcription,
        translation: responseJson.translation,
        sourceLang,
        targetLang,
      })

      // Clear audio blob and error on successful translation
      setLastAudioBlob(null)
      setError('')

    } catch (err) {
      console.error('Translation error:', err)
      setError(err instanceof Error ? `Translation failed: ${err.message}` : 'An unknown error occurred.')
    } finally {
      setIsTranslating(false)
    }
  }

  return (
    <div className="h-screen bg-white text-gray-900 flex flex-col max-w-2xl mx-auto font-sans">

      {/* History Area */}
      <div className="flex-1 overflow-y-auto px-4 py-6">
        {history.length === 0 && !isTranslating && (
          <div className="text-center text-gray-400 pt-32">
            <svg className="w-12 h-12 mx-auto mb-4" fill="none" stroke="currentColor" viewBox="0 0 24 24"><path strokeLinecap="round" strokeLinejoin="round" strokeWidth={1.5} d="M19 11a7 7 0 01-7 7m0 0a7 7 0 01-7-7m7 7v4m0 0H8m4 0h4m-4-8a3 3 0 01-3-3V5a3 3 0 116 0v6a3 3 0 01-3 3z" /></svg>
            <p className="text-base text-gray-500">Click the mic to start translating</p>
          </div>
        )}

        {history.length > 0 && (
          <div className="text-center py-4 border-b border-gray-100">
            <button
              onClick={() => {
                if (confirm('Are you sure you want to clear all conversation history?')) {
                  clearHistory()
                }
              }}
              className="px-4 py-2 text-sm text-red-600 hover:text-red-700 hover:bg-red-50 rounded-lg transition-colors"
            >
              Clear History
            </button>
          </div>
        )}

        {history.map(item => (
          <div key={item.id} className="py-6 border-b border-gray-100 last:border-b-0">
            <p className="text-xl text-gray-900 mb-4 leading-relaxed">{item.transcription}</p>
            <p className="text-xl text-gray-600 leading-relaxed">{item.translation}</p>
          </div>
        ))}

        <div ref={historyEndRef} />
      </div>

      {error && (
        <div className="px-4 py-2 text-center text-xs text-red-600 bg-red-50">
          {error}
        </div>
      )}

      {/* Control Bar */}
      <div className="flex-shrink-0 p-4 bg-white flex items-center">
        <div className="w-24 flex justify-start">
          <button
            onClick={cycleLanguagePair}
            className="flex items-center space-x-2 px-3 py-2 rounded-lg hover:bg-gray-50 transition-colors"
            aria-label="Switch language pair"
          >
            <span className="text-lg">{languageFlags[languagePair.split('-')[0]]}</span>
            <svg className="w-4 h-4 text-gray-400" fill="none" stroke="currentColor" viewBox="0 0 24 24">
              <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M8 7h12m0 0l-4-4m4 4l-4 4m0 6H4m0 0l4 4m-4-4l4-4" />
            </svg>
            <span className="text-lg">{languageFlags[languagePair.split('-')[1]]}</span>
          </button>
        </div>

        <div className="flex-1 flex justify-center">
          {isTranslating ? (
            <div className="w-20 h-20 rounded-full bg-gray-500 flex items-center justify-center">
              <div className="text-center text-white">
                <div className="animate-spin rounded-full h-6 w-6 border-b-2 border-white mx-auto mb-1"></div>
                <p className="text-xs">Translating</p>
              </div>
            </div>
          ) : error && lastAudioBlob ? (
            <div className="text-center">
              <div className="w-20 h-20 rounded-full bg-red-500 flex items-center justify-center mb-2">
                <svg className="w-8 h-8 text-white" fill="none" stroke="currentColor" viewBox="0 0 24 24">
                  <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M12 8v4m0 4h.01M21 12a9 9 0 11-18 0 9 9 0 0118 0z" />
                </svg>
              </div>
              <button
                onClick={() => lastAudioBlob && translateAudio(lastAudioBlob)}
                className="px-3 py-1 bg-blue-500 hover:bg-blue-600 text-white rounded text-sm transition-colors"
              >
                Retry
              </button>
            </div>
          ) : error ? (
            <div className="w-20 h-20 rounded-full bg-red-500 flex items-center justify-center">
              <svg className="w-8 h-8 text-white" fill="none" stroke="currentColor" viewBox="0 0 24 24">
                <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M12 8v4m0 4h.01M21 12a9 9 0 11-18 0 9 9 0 0118 0z" />
              </svg>
            </div>
          ) : (
            <button
              onClick={isRecording ? stopRecording : startRecording}
              disabled={isTranslating}
              className={`w-20 h-20 rounded-full flex items-center justify-center text-white transition-all transform active:scale-90 disabled:opacity-50 ${isRecording ? 'bg-red-500 animate-pulse' : 'bg-blue-500'
                }`}
            >
              {isRecording ? (
                <div className="text-center">
                  <div className="h-6 w-6 bg-white rounded-md mx-auto"></div>
                  <p className="text-xs mt-1">{timer}</p>
                </div>
              ) : (
                <svg className="w-10 h-10" fill="currentColor" viewBox="0 0 20 20"><path fillRule="evenodd" d="M7 4a3 3 0 016 0v4a3 3 0 11-6 0V4zm4 10.93A7.001 7.001 0 0017 8a1 1 0 10-2 0A5 5 0 115 8a1 1 0 00-2 0 7.001 7.001 0 006 6.93V17H6a1 1 0 100 2h8a1 1 0 100-2h-3v-2.07z" clipRule="evenodd" /></svg>
              )}
            </button>
          )}
        </div>

        <div className="w-24 flex justify-end">
          <button
            onClick={() => setShowSettings(true)}
            className="p-2 rounded-lg hover:bg-gray-50 text-gray-400 w-12 h-12 flex items-center justify-center transition-colors"
            aria-label="Settings"
          >
            <svg className="w-7 h-7" fill="none" stroke="currentColor" viewBox="0 0 24 24"><path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M10.325 4.317c.426-1.756 2.924-1.756 3.50 0a1.724 1.724 0 002.573 1.066c1.543-.94 3.31.826 2.37 2.37a1.724 1.724 0 001.065 2.572c1.756.426 1.756 2.924 0 3.35a1.724 1.724 0 00-1.066 2.573c.94 1.543-.826 3.31-2.37 2.37a1.724 1.724 0 00-2.572 1.065c-.426 1.756-2.924 1.756-3.35 0a1.724 1.724 0 00-2.573-1.066c-1.543.94-3.31-.826-2.37-2.37a1.724 1.724 0 00-1.065-2.572c-1.756-.426-1.756-2.924 0-3.35a1.724 1.724 0 001.066-2.573c-.94-1.543.826-3.31 2.37-2.37.996.608 2.296.07 2.572-1.065z" /><path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M15 12a3 3 0 11-6 0 3 3 0 016 0z" /></svg>
          </button>
        </div>
      </div>

      {showSettings && (
        <div className="fixed inset-0 bg-black bg-opacity-40 z-50 flex items-center justify-center p-4">
          <div className="bg-white p-5 rounded-lg w-full max-w-sm shadow-xl border">
            <div className="flex justify-between items-center mb-4">
              <h2 className="text-lg font-semibold">Settings</h2>
              <button onClick={() => setShowSettings(false)} className="text-gray-400 hover:text-gray-600 text-2xl leading-none">&times;</button>
            </div>
            <div className="space-y-4">
              <div>
                <label className="block text-sm text-gray-600 mb-1">Model</label>
                <select
                  value={model}
                  onChange={(e) => setModel(e.target.value as 'gemini-2.5-flash' | 'gemini-2.5-pro')}
                  className="w-full p-2 rounded border border-gray-300 focus:border-blue-500 focus:outline-none"
                >
                  <option value="gemini-2.5-pro">Gemini 2.5 Pro</option>
                  <option value="gemini-2.5-flash">Gemini 2.5 Flash</option>
                </select>
              </div>
              <div>
                <label className="block text-sm text-gray-600 mb-1">Gemini API Key</label>
                <input
                  type="password"
                  value={apiKey}
                  onChange={(e) => setApiKey(e.target.value)}
                  className="w-full p-2 rounded border border-gray-300 focus:border-blue-500 focus:outline-none text-sm"
                  placeholder="Enter your API key"
                />
              </div>
              <button onClick={saveSettings} className="w-full py-2 bg-blue-600 hover:bg-blue-700 text-white rounded font-medium transition-colors">
                Save Settings
              </button>
            </div>
          </div>
        </div>
      )}
    </div>
  )
}

export default App
