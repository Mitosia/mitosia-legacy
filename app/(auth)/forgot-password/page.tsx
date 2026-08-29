"use client";

import Link from "next/link";
import { type ChangeEvent, type FormEvent, useCallback, useState } from "react";
import { Button } from "@/components/ui/button";
import {
  Card,
  CardContent,
  CardDescription,
  CardHeader,
  CardTitle,
} from "@/components/ui/card";
import {
  Field,
  FieldError,
  FieldGroup,
  FieldLabel,
} from "@/components/ui/field";
import { Input } from "@/components/ui/input";
import { Spinner } from "@/components/ui/spinner";
import { requestPasswordReset } from "@/lib/auth-client";

export default function ForgotPasswordPage() {
  const [email, setEmail] = useState("");
  const [error, setError] = useState<string | null>(null);
  const [isPending, setIsPending] = useState(false);
  const [isSent, setIsSent] = useState(false);

  const handleEmailChange = useCallback(
    (event: ChangeEvent<HTMLInputElement>) => setEmail(event.target.value),
    []
  );
  const handleTryAnotherEmail = useCallback(() => setIsSent(false), []);
  const handleSubmit = useCallback(
    async (event: FormEvent<HTMLFormElement>) => {
      event.preventDefault();
      setError(null);
      setIsPending(true);

      const formData = new FormData(event.currentTarget);
      const submittedEmail = String(formData.get("email")).trim();
      const { error: requestError } = await requestPasswordReset({
        email: submittedEmail,
        redirectTo: "/reset-password",
      });

      setIsPending(false);
      if (requestError) {
        setError("We couldn't start password recovery. Try again in a moment.");
        return;
      }

      setEmail(submittedEmail);
      setIsSent(true);
    },
    []
  );

  if (isSent) {
    return (
      <Card>
        <CardHeader>
          <CardTitle>Check your email</CardTitle>
          <CardDescription>
            If an account exists for{" "}
            <span className="font-medium">{email}</span>, a password reset link
            is on its way.
          </CardDescription>
        </CardHeader>
        <CardContent className="space-y-5">
          <p className="text-muted-foreground text-sm">
            The link expires in one hour. Check your spam folder if it does not
            arrive in a few minutes.
          </p>
          <div className="flex flex-col gap-2">
            <Button nativeButton={false} render={<Link href="/sign-in" />}>
              Back to sign in
            </Button>
            <Button onClick={handleTryAnotherEmail} variant="ghost">
              Try another email
            </Button>
          </div>
        </CardContent>
      </Card>
    );
  }

  return (
    <Card>
      <CardHeader>
        <CardTitle>Reset your password</CardTitle>
        <CardDescription>
          Enter your account email and we’ll send a secure reset link.
        </CardDescription>
      </CardHeader>
      <CardContent>
        <form onSubmit={handleSubmit}>
          <FieldGroup>
            <Field>
              <FieldLabel htmlFor="email">Email</FieldLabel>
              <Input
                autoComplete="email"
                autoFocus
                id="email"
                name="email"
                onChange={handleEmailChange}
                placeholder="you@agency.com"
                required
                type="email"
                value={email}
              />
            </Field>
            {error ? <FieldError>{error}</FieldError> : null}
            <Button disabled={isPending} type="submit">
              {isPending ? <Spinner /> : null}
              Send reset link
            </Button>
            <p className="text-center text-muted-foreground text-sm">
              Remembered it?{" "}
              <Link className="text-foreground underline" href="/sign-in">
                Back to sign in
              </Link>
            </p>
          </FieldGroup>
        </form>
      </CardContent>
    </Card>
  );
}
