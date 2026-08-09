"use client";

import { useActionState, useEffect, useId, useRef } from "react";
import { Button } from "@/components/ui/button";
import { Field, FieldLabel } from "@/components/ui/field";
import { Input } from "@/components/ui/input";
import { Spinner } from "@/components/ui/spinner";
import { type ActionState, initialActionState } from "@/lib/action-state";

interface InlineCreateFormProps {
  action: (state: ActionState, formData: FormData) => Promise<ActionState>;
  buttonLabel: string;
  hiddenFields?: Record<string, string>;
  label: string;
  placeholder: string;
}

export function InlineCreateForm({
  action,
  buttonLabel,
  hiddenFields,
  label,
  placeholder,
}: InlineCreateFormProps) {
  const inputId = useId();
  const formRef = useRef<HTMLFormElement>(null);
  const [state, formAction, isPending] = useActionState(
    action,
    initialActionState
  );

  useEffect(() => {
    if (state.success) {
      formRef.current?.reset();
    }
  }, [state]);

  return (
    <form action={formAction} ref={formRef}>
      <div className="flex items-end gap-2">
        {Object.entries(hiddenFields ?? {}).map(([name, value]) => (
          <input key={name} name={name} type="hidden" value={value} />
        ))}
        <Field className="flex-1">
          <FieldLabel htmlFor={inputId}>{label}</FieldLabel>
          <Input id={inputId} name="name" placeholder={placeholder} required />
        </Field>
        <Button disabled={isPending} type="submit">
          {isPending ? <Spinner /> : null}
          {buttonLabel}
        </Button>
      </div>
      {state.error ? (
        <p className="mt-2 text-destructive text-sm">{state.error}</p>
      ) : null}
    </form>
  );
}
