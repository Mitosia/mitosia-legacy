import { APIError } from "better-auth";
import { headers } from "next/headers";
import Link from "next/link";
import { redirect } from "next/navigation";
import { buttonVariants } from "@/components/ui/button";
import {
  Card,
  CardContent,
  CardDescription,
  CardHeader,
  CardTitle,
} from "@/components/ui/card";
import { auth } from "@/lib/auth";
import { requireSession } from "@/lib/org";

export default async function AcceptInvitationPage(
  props: PageProps<"/accept-invitation/[invitationId]">
) {
  await requireSession();
  const { invitationId } = await props.params;

  let organizationId: string | null = null;
  let errorMessage: string | null = null;

  try {
    const result = await auth.api.acceptInvitation({
      body: { invitationId },
      headers: await headers(),
    });
    organizationId = result?.member.organizationId ?? null;
  } catch (error) {
    errorMessage =
      error instanceof APIError
        ? error.message
        : "This invitation is invalid or has expired.";
  }

  if (organizationId) {
    await auth.api.setActiveOrganization({
      body: { organizationId },
      headers: await headers(),
    });
    redirect("/dashboard");
  }

  return (
    <div className="mx-auto w-full max-w-md">
      <Card>
        <CardHeader>
          <CardTitle>Invitation problem</CardTitle>
          <CardDescription>
            {errorMessage ?? "This invitation could not be accepted."}
          </CardDescription>
        </CardHeader>
        <CardContent>
          <p className="mb-4 text-muted-foreground text-sm">
            Make sure you are signed in with the same email address the
            invitation was sent to.
          </p>
          <Link
            className={buttonVariants({ variant: "outline" })}
            href="/dashboard"
          >
            Back to dashboard
          </Link>
        </CardContent>
      </Card>
    </div>
  );
}
