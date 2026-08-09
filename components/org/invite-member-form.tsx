"use client";

import { useActionState, useEffect, useId, useRef } from "react";
import { Button } from "@/components/ui/button";
import { Field, FieldLabel } from "@/components/ui/field";
import { Input } from "@/components/ui/input";
import { Spinner } from "@/components/ui/spinner";
import { type ActionState, initialActionState } from "@/lib/action-state";

export function InviteMemberForm({
  action,
}: {
  action: (state: ActionState, formData: FormData) => Promise<ActionState>;
}) {
  const emailId = useId();
  const roleId = useId();
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
        <Field className="flex-1">
          <FieldLabel htmlFor={emailId}>Invite by email</FieldLabel>
          <Input
            id={emailId}
            name="email"
            placeholder="teammate@agency.com"
            required
            type="email"
          />
        </Field>
        <Field>
          <FieldLabel htmlFor={roleId}>Role</FieldLabel>
          <select
            className="h-9 rounded-md border border-input bg-transparent px-3 text-sm shadow-xs outline-none"
            defaultValue="member"
            id={roleId}
            name="role"
          >
            <option value="member">Member</option>
            <option value="admin">Admin</option>
          </select>
        </Field>
        <Button disabled={isPending} type="submit">
          {isPending ? <Spinner /> : null}
          Send invite
        </Button>
      </div>
      {state.error ? (
        <p className="mt-2 text-destructive text-sm">{state.error}</p>
      ) : null}
      {state.success ? (
        <p className="mt-2 text-muted-foreground text-sm">
          Invitation created. Email delivery arrives in a later sprint — use
          “Copy invite link” below to share it.
        </p>
      ) : null}
    </form>
  );
}
