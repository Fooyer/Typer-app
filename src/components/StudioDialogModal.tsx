import { useState } from "react";

export interface StudioDialogRequest {
  kind: "confirm" | "alert" | "prompt";
  message: string;
  onAnswer: (answer: string, msg?: string) => void;
}

function StudioDialogModal({ request }: { request: StudioDialogRequest }) {
  const [value, setValue] = useState("");
  const { kind, message, onAnswer } = request;

  return (
    <div className="modal-overlay" onClick={() => onAnswer("2")}>
      <div className="modal" onClick={(event) => event.stopPropagation()}>
        <h4>Ação do servidor</h4>
        <p>{message}</p>
        {kind === "prompt" && (
          <input
            autoFocus
            value={value}
            onChange={(event) => setValue(event.target.value)}
            onKeyDown={(event) => event.key === "Enter" && onAnswer(value ? "1" : "2", value)}
          />
        )}
        <div className="modal-actions">
          {kind === "alert" ? (
            <button type="button" onClick={() => onAnswer("1")}>
              OK
            </button>
          ) : (
            <>
              <button type="button" onClick={() => onAnswer("1", value)}>
                Sim
              </button>
              {kind === "confirm" && (
                <button type="button" onClick={() => onAnswer("0", value)}>
                  Não
                </button>
              )}
              <button type="button" onClick={() => onAnswer("2", value)}>
                Cancelar
              </button>
            </>
          )}
        </div>
      </div>
    </div>
  );
}

export default StudioDialogModal;
