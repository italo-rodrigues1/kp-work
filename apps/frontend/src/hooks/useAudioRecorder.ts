import { useState, useRef, useCallback } from 'react'
import type { AudioAttachment } from '../types/chat'

export function useAudioRecorder() {
  const [isRecording, setIsRecording] = useState(false)
  const [recordingTime, setRecordingTime] = useState(0)
  const mediaRecorderRef = useRef<MediaRecorder | null>(null)
  const audioChunksRef = useRef<Blob[]>([])
  const timerRef = useRef<number | null>(null)

  const startRecording = useCallback(async () => {
    try {
      const stream = await navigator.mediaDevices.getUserMedia({ audio: true })
      const mediaRecorder = new MediaRecorder(stream)
      mediaRecorderRef.current = mediaRecorder
      audioChunksRef.current = []

      mediaRecorder.ondataavailable = (event) => {
        if (event.data.size > 0) {
          audioChunksRef.current.push(event.data)
        }
      }

      mediaRecorder.start(100)
      setIsRecording(true)
      setRecordingTime(0)

      timerRef.current = window.setInterval(() => {
        setRecordingTime((prev) => prev + 1)
      }, 1000)
    } catch (err) {
      console.error('Permission denied or error accessing microphone:', err)
      alert('Não foi possível acessar o microfone. Verifique as permissões do seu navegador.')
    }
  }, [])

  const stopRecording = useCallback((): Promise<AudioAttachment | null> => {
    return new Promise((resolve) => {
      if (!mediaRecorderRef.current || !isRecording) {
        resolve(null)
        return
      }

      const durationSeconds = recordingTime

      mediaRecorderRef.current.onstop = () => {
        const audioBlob = new Blob(audioChunksRef.current, { type: 'audio/webm' })
        const audioUrl = URL.createObjectURL(audioBlob)
        
        // Stop audio tracks to release microphone
        mediaRecorderRef.current?.stream.getTracks().forEach((track) => track.stop())

        setIsRecording(false)
        if (timerRef.current) clearInterval(timerRef.current)
        setRecordingTime(0)

        const attachment: AudioAttachment = {
          id: `audio-${Date.now()}`,
          blob: audioBlob,
          url: audioUrl,
          durationSeconds,
        }
        resolve(attachment)
      }

      mediaRecorderRef.current.stop()
    })
  }, [isRecording, recordingTime])

  const cancelRecording = useCallback(() => {
    if (mediaRecorderRef.current && isRecording) {
      mediaRecorderRef.current.stop()
      mediaRecorderRef.current.stream.getTracks().forEach((track) => track.stop())
    }
    setIsRecording(false)
    if (timerRef.current) clearInterval(timerRef.current)
    setRecordingTime(0)
    audioChunksRef.current = []
  }, [isRecording])

  return {
    isRecording,
    recordingTime,
    startRecording,
    stopRecording,
    cancelRecording,
  }
}
