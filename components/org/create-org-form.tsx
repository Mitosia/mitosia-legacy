"use client";

import { useRouter } from "next/navigation";
import { type FormEvent, useCallback, useState } from "react";
import { Button } from "@/components/ui/button";
import {
  Card,
  CardContent,
  CardDescription,
  CardHeader,
  CardTitle,
} from "@/components/ui/card";
import { Field, FieldLabel } from "@/components/ui/field";
import { Input } from "@/components/ui/input";
import { Spinner } from "@/components/ui/spinner";
import { authClient } from "@/lib/auth-client";

const SLUG_SUFFIX_BASE = 36;
const SLUG_SUFFIX_LENGTH = 4;
const MAX_SLUG_LENGTH = 40;

function slugify(name: string) {
  const base = name
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/(^-|-$)/g, "")
    .slice(0, MAX_SLUG_LENGTH);
  const suffix = Math.random()
    .toString(SLUG_SUFFIX_BASE)
    .slice(2, 2 + SLUG_SUFFIX_LENGTH);
  return `${base || "org"}-${suffix}`;
}

export function CreateOrgForm() {
  const router = useRouter();
  const [error, setError] = useState<string | null>(null);
  const [isPending, setIsPending] = useState(false);

  const handleSubmit = useCallback(
    async (event: FormEvent<HTMLFormElement>) => {
      event.preventDefault();
      setError(null);
      setIsPending(true);

      const formData = new FormData(event.currentTarget);
      const name = String(formData.get("name") ?? "").trim();

      const { data, error: createError } = await authClient.organization.create(
        {
          name,
          slug: slugify(name),
        }
      );

      if (createError || !data) {
        setError(createError?.message ?? "Unable to create the organization.");
        setIsPending(false);
        return;
      }

      await authClient.organization.setActive({ organizationId: data.id });
      router.push("/dashboard");
      router.refresh();
    },
    [router]
  );

  return (
    <Card>
      <CardHeader>
        <CardTitle>Create your organization</CardTitle>
        <CardDescription>
          The workspace for your agency. Clients, brands, and campaigns live
          inside it.
        </CardDescription>
      </CardHeader>
      <CardContent>
        <form onSubmit={handleSubmit}>
          <div className="flex flex-col gap-4">
            <Field>
              <FieldLabel htmlFor="org-name">Organization name</FieldLabel>
              <Input
                id="org-name"
                name="name"
                placeholder="Acme Content Studio"
                required
              />
            </Field>
            {error ? <p className="text-destructive text-sm">{error}</p> : null}
            <Button disabled={isPending} type="submit">
              {isPending ? <Spinner /> : null}
              Create organization
            </Button>
          </div>
        </form>
      </CardContent>
    </Card>
  );
}
