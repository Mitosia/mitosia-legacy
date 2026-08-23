"use client";

import { useRouter } from "next/navigation";
import { useActionState, useCallback, useEffect } from "react";
import { Button } from "@/components/ui/button";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";
import { Field, FieldLabel } from "@/components/ui/field";
import { Input } from "@/components/ui/input";
import {
  correctWordAction,
  updateSpeakerLabelsAction,
} from "@/lib/actions/transcripts";
import { speakerDisplayName } from "@/lib/transcription/paragraphs";

// The two correction dialogs. Both refresh the route on success: a rename
// flows back through transcript.speaker_labels, a word correction produces
// a new revision whose storage key changes the panel's transcript URL,
// which re-fetches the JSON.

function useCloseOnSuccess(
  success: boolean | undefined,
  onClose: () => void
): void {
  const router = useRouter();
  useEffect(() => {
    if (success) {
      router.refresh();
      onClose();
    }
  }, [success, router, onClose]);
}

export function SpeakerLabelsDialog({
  onClose,
  open,
  sourceId,
  speakerLabels,
  speakers,
}: {
  onClose: () => void;
  open: boolean;
  sourceId: string;
  speakerLabels: Record<string, string> | null;
  speakers: string[];
}) {
  const [state, formAction, pending] = useActionState(
    updateSpeakerLabelsAction,
    {}
  );
  useCloseOnSuccess(state.success, onClose);
  const handleOpenChange = useCallback(
    (next: boolean) => {
      if (!next) {
        onClose();
      }
    },
    [onClose]
  );
  const submit = useCallback(
    (formData: FormData) => {
      const labels: Record<string, string> = {};
      for (const speaker of speakers) {
        labels[speaker] = String(formData.get(`speaker-${speaker}`) ?? "");
      }
      formData.set("labels", JSON.stringify(labels));
      formData.set("sourceId", sourceId);
      formAction(formData);
    },
    [speakers, sourceId, formAction]
  );

  return (
    <Dialog onOpenChange={handleOpenChange} open={open}>
      <DialogContent data-testid="speaker-labels-dialog">
        <DialogHeader>
          <DialogTitle>Name speakers</DialogTitle>
          <DialogDescription>
            Give diarized voices real names. If one person was split into two
            speakers, give both the same name to merge them.
          </DialogDescription>
        </DialogHeader>
        <form action={submit} className="flex flex-col gap-4">
          {speakers.map((speaker) => (
            <Field key={speaker}>
              <FieldLabel htmlFor={`speaker-${speaker}`}>
                {speakerDisplayName(speaker, null)}
              </FieldLabel>
              <Input
                defaultValue={speakerLabels?.[speaker] ?? ""}
                id={`speaker-${speaker}`}
                name={`speaker-${speaker}`}
                placeholder="Name"
              />
            </Field>
          ))}
          {state.error ? (
            <p className="text-destructive text-sm">{state.error}</p>
          ) : null}
          <DialogFooter>
            <Button
              disabled={pending}
              onClick={onClose}
              type="button"
              variant="outline"
            >
              Cancel
            </Button>
            <Button
              data-testid="speaker-labels-save"
              disabled={pending}
              type="submit"
            >
              Save names
            </Button>
          </DialogFooter>
        </form>
      </DialogContent>
    </Dialog>
  );
}

export interface WordToCorrect {
  index: number;
  text: string;
}

export function CorrectWordDialog({
  baseRevision,
  onClose,
  sourceId,
  word,
}: {
  baseRevision: number;
  onClose: () => void;
  sourceId: string;
  word: WordToCorrect | null;
}) {
  const [state, formAction, pending] = useActionState(correctWordAction, {});
  useCloseOnSuccess(state.success, onClose);
  const handleOpenChange = useCallback(
    (next: boolean) => {
      if (!next) {
        onClose();
      }
    },
    [onClose]
  );

  return (
    <Dialog onOpenChange={handleOpenChange} open={word !== null}>
      <DialogContent data-testid="correct-word-dialog">
        <DialogHeader>
          <DialogTitle>Correct word</DialogTitle>
          <DialogDescription>
            Fixes the transcript text; timing stays put. Saved as a new
            revision.
          </DialogDescription>
        </DialogHeader>
        {word ? (
          <form action={formAction} className="flex flex-col gap-4">
            <input name="sourceId" type="hidden" value={sourceId} />
            <input name="baseRevision" type="hidden" value={baseRevision} />
            <input name="wordIndex" type="hidden" value={word.index} />
            <Field>
              <FieldLabel htmlFor="corrected-word">Replacement</FieldLabel>
              <Input
                autoFocus
                defaultValue={word.text}
                id="corrected-word"
                key={word.index}
                name="text"
              />
            </Field>
            {state.error ? (
              <p className="text-destructive text-sm">{state.error}</p>
            ) : null}
            <DialogFooter>
              <Button
                disabled={pending}
                onClick={onClose}
                type="button"
                variant="outline"
              >
                Cancel
              </Button>
              <Button
                data-testid="correct-word-save"
                disabled={pending}
                type="submit"
              >
                Save correction
              </Button>
            </DialogFooter>
          </form>
        ) : null}
      </DialogContent>
    </Dialog>
  );
}
