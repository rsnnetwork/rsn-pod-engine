// ─── An event's extra matching questions: the read and the two writes (Part 3 Task 10 over Task 5's routes) ─────────
// The read follows session:<id>:questions (the organiser's save reaches the organisers, the people with a place and
// everyone who answered; a person's answer change reaches the organisers and that person) and session:<id>:participants
// (someone taking or leaving a place moves the organisers' counts and answers). The server shapes the answer per
// viewer: everyone who may answer reads the questions and their own answers; only organisers read everyone's answers.
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import type { EventAnswers, EventMatchingQuestion, EventQuestionsView } from '@rsn/shared';
import api from '@/lib/api';
import { E } from '@/realtime/entities';

export const questionsKey = (sessionId: string) => ['session-questions', sessionId] as const;

export function useEventQuestions(sessionId: string, enabled = true) {
  return useQuery<EventQuestionsView>({
    queryKey: questionsKey(sessionId),
    queryFn: () => api.get(`/sessions/${sessionId}/questions`).then((r) => r.data.data as EventQuestionsView),
    enabled: enabled && !!sessionId,
    retry: (count, err: unknown) => {
      const status = (err as { response?: { status?: number } })?.response?.status;
      return status !== 403 && status !== 404 && count < 2;
    },
    meta: { entities: [E.sessionQuestions(sessionId), E.sessionParticipants(sessionId)] },
  });
}

/** The organiser saves the whole list (an empty list removes every question). */
export function useSaveEventQuestions(sessionId: string) {
  const qc = useQueryClient();
  return useMutation({
    networkMode: 'always',
    mutationFn: (questions: EventMatchingQuestion[]) => api.put(`/sessions/${sessionId}/questions`, {
      questions: questions.map((q) => ({
        key: q.key, prompt: q.prompt, kind: q.kind, prefer: q.prefer, required: q.required,
        options: q.options.map((o) => ({ key: o.key, label: o.label })),
      })),
    }).then((r) => r.data.data as { questions: EventMatchingQuestion[] }),
    onSuccess: () => { qc.invalidateQueries({ queryKey: questionsKey(sessionId) }); },
  });
}

/** A person saves their own answers (until the event goes live). */
export function useSaveMyAnswers(sessionId: string) {
  const qc = useQueryClient();
  return useMutation({
    networkMode: 'always',
    mutationFn: (answers: EventAnswers) => api.put(`/sessions/${sessionId}/questions/mine`, { answers })
      .then((r) => r.data.data as { mine: EventAnswers; missingRequired: string[] }),
    onSuccess: () => { qc.invalidateQueries({ queryKey: questionsKey(sessionId) }); },
  });
}
