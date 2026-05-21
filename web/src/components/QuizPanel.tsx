import { useState } from "react";
import "./QuizPanel.css";
import type { Question, QuizSelfEval, QuizState } from "../types";

interface Props {
  changesetId: string;
  quiz: QuizState;
  onSubmit: (questionId: string, answer: string) => void;
  onDismiss: () => void;
  onSelfEval: (questionId: string, selfEval: QuizSelfEval) => void;
}

export function QuizPanel({ changesetId, quiz, onSubmit, onDismiss, onSelfEval }: Props) {
  const questions = quiz.questions[changesetId] ?? [];
  if (questions.length === 0) return null;
  const answered = questions.filter((q) => quiz.answers[q.id]?.submittedAt).length;
  const active = quiz.active
    ? questions.find((q) => q.id === quiz.active!.questionId) ?? null
    : null;
  const activeAnswer = active ? quiz.answers[active.id] ?? null : null;

  return (
    <section className="panel quiz-panel">
      <header className="panel__h">
        <span>Comprehension</span>
        <span className="quiz-panel__count">{answered} / {questions.length}</span>
      </header>
      {active && (
        activeAnswer
          ? <Reveal q={active} answer={activeAnswer} onSelfEval={onSelfEval} />
          : <Active q={active} onSubmit={onSubmit} onDismiss={onDismiss} />
      )}
    </section>
  );
}

function targetLabel(q: Question): string {
  switch (q.target.kind) {
    case "changeset": return "About: this changeset";
    case "file": return `About: ${q.target.path}`;
    case "hunk": return `About: hunk ${q.target.hunkId}`;
    case "symbol": return `About: ${q.target.name} (${q.target.definedIn})`;
  }
}

function Active({ q, onSubmit, onDismiss }: {
  q: Question;
  onSubmit: (id: string, answer: string) => void;
  onDismiss: () => void;
}) {
  const [draft, setDraft] = useState("");
  const canSubmit = draft.trim().length > 0;
  return (
    <div className="quiz-panel__body">
      <div className="quiz-panel__target">{targetLabel(q)}</div>
      <div className="quiz-panel__prompt">{q.prompt}</div>
      <textarea
        className="quiz-panel__textarea"
        value={draft}
        onChange={(e) => setDraft(e.target.value)}
        rows={4}
        autoFocus
      />
      <div className="quiz-panel__actions">
        <button disabled={!canSubmit} onClick={() => onSubmit(q.id, draft.trim())}>Submit</button>
        <button onClick={onDismiss}>Skip</button>
      </div>
    </div>
  );
}

function Reveal({ q, answer, onSelfEval }: {
  q: Question;
  answer: { answer: string; selfEval: QuizSelfEval | null };
  onSelfEval: (id: string, e: QuizSelfEval) => void;
}) {
  return (
    <div className="quiz-panel__body">
      <div className="quiz-panel__target">{targetLabel(q)}</div>
      <div className="quiz-panel__prompt">{q.prompt}</div>
      <div className="quiz-panel__reveal-label">Your answer:</div>
      <blockquote className="quiz-panel__quote">{answer.answer}</blockquote>
      <div className="quiz-panel__reveal-label">Claude's answer:</div>
      <blockquote className="quiz-panel__quote">{q.claudeAnswer}</blockquote>
      <div className="quiz-panel__reveal-label">How did you do?</div>
      <div className="quiz-panel__actions">
        <button
          aria-pressed={answer.selfEval === "got_it"}
          onClick={() => onSelfEval(q.id, "got_it")}
        >Got it</button>
        <button
          aria-pressed={answer.selfEval === "claude_wrong"}
          onClick={() => onSelfEval(q.id, "claude_wrong")}
        >Claude's off</button>
        <button
          aria-pressed={answer.selfEval === "missed"}
          onClick={() => onSelfEval(q.id, "missed")}
        >Missed it</button>
      </div>
    </div>
  );
}
