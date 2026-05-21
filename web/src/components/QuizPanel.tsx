import "./QuizPanel.css";
import type { QuizState } from "../types";

interface Props {
  changesetId: string;
  quiz: QuizState;
}

export function QuizPanel({ changesetId, quiz }: Props) {
  const questions = quiz.questions[changesetId] ?? [];
  if (questions.length === 0) return null;

  const answered = questions.filter((q) => quiz.answers[q.id]?.submittedAt).length;

  // Resting state only — active / reveal land in Task 12.
  return (
    <section className="panel quiz-panel">
      <header className="panel__h">
        <span>Comprehension</span>
        <span className="quiz-panel__count">{answered} / {questions.length}</span>
      </header>
    </section>
  );
}
