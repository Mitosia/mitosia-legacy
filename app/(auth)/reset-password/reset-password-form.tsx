"use client";

import Link from "next/link";
import { type FormEvent, useCallback, useState } from "react";
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
  FieldDescription,
  FieldError,
  FieldGroup,
  FieldLabel,
} from "@/components/ui/field";
import { Input } from "@/components/ui/input";
import { Spinner } from "@/components/ui/spinner";
import { resetPassword } from "@/lib/auth-client";

const MIN_PASSWORD_LENGTH = 8;

export function ResetPasswordForm({ token }: { token: string | null }) {
  const [error, setError] = useState<string | null>(null);
  const [isComplete, setIsComplete] = useState(false);
  const [isPending, setIsPending] = useState(false);

  const handleSubmit = useCallback(
    async (event: FormEvent<HTMLFormElement>) => {
      event.preventDefault();
      if (!token) {
        return;
      }

      setError(null);
      const formData = new FormData(event.currentTarget);
      const password = String(formData.get("password"));
      const confirmPassword = String(formData.get("confirmPassword"));

      if (password !== confirmPassword) {
        setError("The passwords do not match.");
        return;
      }

      setIsPending(true);
      const { error: resetError } = await resetPassword({
        newPassword: password,
        token,
      });
      setIsPending(false);

      if (resetError) {
        setError(
          resetError.code === "INVALID_TOKEN"
            ? "This reset link has expired or has already been used."
            : (resetError.message ?? "Unable to reset your password.")
        );
        return;
      }

      setIsComplete(true);
    },
    [token]
  );

  if (!token) {
    return (
      <Card>
        <CardHeader>
          <CardTitle>Reset link unavailable</CardTitle>
          <CardDescription>
            This reset link is invalid, expired, or has already been used.
          </CardDescription>
        </CardHeader>
        <CardContent className="space-y-3">
          <Button
            className="w-full"
            nativeButton={false}
            render={<Link href="/forgot-password" />}
          >
            Request a new link
          </Button>
          <p className="text-center text-muted-foreground text-sm">
            <Link className="text-foreground underline" href="/sign-in">
              Back to sign in
            </Link>
          </p>
        </CardContent>
      </Card>
    );
  }

  if (isComplete) {
    return (
      <Card>
        <CardHeader>
          <CardTitle>Password updated</CardTitle>
          <CardDescription>
            Your new password is ready. Sign in again on your devices.
          </CardDescription>
        </CardHeader>
        <CardContent>
          <Button
            className="w-full"
            nativeButton={false}
            render={<Link href="/sign-in" />}
          >
            Sign in with new password
          </Button>
        </CardContent>
      </Card>
    );
  }

  return (
    <Card>
      <CardHeader>
        <CardTitle>Choose a new password</CardTitle>
        <CardDescription>
          Use at least {MIN_PASSWORD_LENGTH} characters and make it unique to
          Mitosia.
        </CardDescription>
      </CardHeader>
      <CardContent>
        <form onSubmit={handleSubmit}>
          <FieldGroup>
            <Field>
              <FieldLabel htmlFor="password">New password</FieldLabel>
              <Input
                autoComplete="new-password"
                autoFocus
                id="password"
                minLength={MIN_PASSWORD_LENGTH}
                name="password"
                required
                type="password"
              />
              <FieldDescription>
                At least {MIN_PASSWORD_LENGTH} characters.
              </FieldDescription>
            </Field>
            <Field>
              <FieldLabel htmlFor="confirmPassword">
                Confirm new password
              </FieldLabel>
              <Input
                autoComplete="new-password"
                id="confirmPassword"
                minLength={MIN_PASSWORD_LENGTH}
                name="confirmPassword"
                required
                type="password"
              />
            </Field>
            {error ? <FieldError>{error}</FieldError> : null}
            <Button disabled={isPending} type="submit">
              {isPending ? <Spinner /> : null}
              Reset password
            </Button>
          </FieldGroup>
        </form>
      </CardContent>
    </Card>
  );
}
