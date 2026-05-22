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
  const [expanded, setExpanded] = useState(false);
  const [viewingId, setViewingId] = useState<string | null>(null);

  const questions = quiz.questions[changesetId] ?? [];
  if (questions.length === 0) return null;
  const answered = questions.filter((q) => quiz.answers[q.id]?.submittedAt).length;
  const active = quiz.active
    ? questions.find((q) => q.id === quiz.active!.questionId) ?? null
    : null;
  const activeAnswer = active ? quiz.answers[active.id] ?? null : null;
  const showActive = !!active && !(activeAnswer && activeAnswer.selfEval);
  const inSequence = !!quiz.active && quiz.active.mode === "sequence";
  const sequencePosition = inSequence
    ? `Question ${answered + 1} of ${questions.length}`
    : null;

  const viewing = viewingId ? questions.find((q) => q.id === viewingId) ?? null : null;
  const viewingAnswer = viewing ? quiz.answers[viewing.id] ?? null : null;

  return (
    <section className="panel quiz-panel">
      <header className="panel__h quiz-panel__header">
        {showActive ? (
          <>
            <span>Comprehension</span>
            <span className="quiz-panel__count">{answered} / {questions.length}</span>
          </>
        ) : (
          <button
            type="button"
            className="quiz-panel__toggle"
            aria-expanded={expanded}
            onClick={() => {
              setExpanded((v) => !v);
              setViewingId(null);
            }}
          >
            <span className="quiz-panel__chevron" aria-hidden="true">{expanded ? "▾" : "▸"}</span>
            <span>Comprehension</span>
            <span className="quiz-panel__count">{answered} / {questions.length}</span>
          </button>
        )}
      </header>

      {showActive && active && (
        <>
          {sequencePosition && (
            <div className="quiz-panel__sequence">{sequencePosition}</div>
          )}
          {activeAnswer
            ? <Reveal q={active} answer={activeAnswer} onSelfEval={onSelfEval} />
            : <Active q={active} onSubmit={onSubmit} onDismiss={onDismiss} />}
        </>
      )}

      {!showActive && expanded && !viewing && (
        <QuestionList
          questions={questions}
          answers={quiz.answers}
          onPick={setViewingId}
        />
      )}

      {!showActive && expanded && viewing && viewingAnswer && (
        <Reveal
          q={viewing}
          answer={viewingAnswer}
          onSelfEval={onSelfEval}
          onBack={() => setViewingId(null)}
        />
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

function selfEvalGlyph(e: QuizSelfEval | null | undefined): string {
  switch (e) {
    case "got_it": return "✓";
    case "claude_wrong": return "≈";
    case "missed": return "✗";
    default: return "•";
  }
}

function QuestionList({
  questions,
  answers,
  onPick,
}: {
  questions: Question[];
  answers: QuizState["answers"];
  onPick: (id: string) => void;
}) {
  return (
    <ul className="quiz-panel__list">
      {questions.map((q) => {
        const a = answers[q.id];
        const isAnswered = !!a?.submittedAt;
        return (
          <li key={q.id}>
            {isAnswered ? (
              <button
                type="button"
                className="quiz-panel__list-row quiz-panel__list-row--answered"
                onClick={() => onPick(q.id)}
              >
                <span className="quiz-panel__list-mark" aria-hidden="true">{selfEvalGlyph(a.selfEval)}</span>
                <span className="quiz-panel__list-target">{targetLabel(q)}</span>
              </button>
            ) : (
              <div className="quiz-panel__list-row quiz-panel__list-row--pending">
                <span className="quiz-panel__list-mark" aria-hidden="true">○</span>
                <span className="quiz-panel__list-target">{targetLabel(q)}</span>
                <span className="quiz-panel__list-note">not yet</span>
              </div>
            )}
          </li>
        );
      })}
    </ul>
  );
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

function Reveal({ q, answer, onSelfEval, onBack }: {
  q: Question;
  answer: { answer: string; selfEval: QuizSelfEval | null };
  onSelfEval: (id: string, e: QuizSelfEval) => void;
  onBack?: () => void;
}) {
  return (
    <div className="quiz-panel__body">
      {onBack && (
        <button type="button" className="quiz-panel__back" onClick={onBack}>← back</button>
      )}
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
