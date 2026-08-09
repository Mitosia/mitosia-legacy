import { headers } from "next/headers";
import { CopyInviteLink } from "@/components/org/copy-invite-link";
import { InviteMemberForm } from "@/components/org/invite-member-form";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import {
  cancelInvitationAction,
  inviteMemberAction,
} from "@/lib/actions/members";
import { auth } from "@/lib/auth";
import { requireOrg } from "@/lib/org";

export default async function MembersPage() {
  await requireOrg();

  const organization = await auth.api.getFullOrganization({
    headers: await headers(),
  });

  if (!organization) {
    return null;
  }

  const pendingInvitations = organization.invitations.filter(
    (invitation) => invitation.status === "pending"
  );

  return (
    <div className="flex flex-col gap-6">
      <div>
        <h1 className="font-semibold text-2xl">Members</h1>
        <p className="text-muted-foreground text-sm">
          People with access to {organization.name}.
        </p>
      </div>

      <InviteMemberForm action={inviteMemberAction} />

      <section className="flex flex-col gap-2">
        <h2 className="font-medium text-lg">Members</h2>
        <ul className="divide-y rounded-md border">
          {organization.members.map((member) => (
            <li
              className="flex items-center justify-between px-4 py-3"
              key={member.id}
            >
              <div>
                <p className="font-medium text-sm">{member.user.name}</p>
                <p className="text-muted-foreground text-sm">
                  {member.user.email}
                </p>
              </div>
              <Badge variant="outline">{member.role}</Badge>
            </li>
          ))}
        </ul>
      </section>

      {pendingInvitations.length > 0 ? (
        <section className="flex flex-col gap-2">
          <h2 className="font-medium text-lg">Pending invitations</h2>
          <ul className="divide-y rounded-md border">
            {pendingInvitations.map((invitation) => (
              <li
                className="flex items-center justify-between px-4 py-3"
                key={invitation.id}
              >
                <div>
                  <p className="font-medium text-sm">{invitation.email}</p>
                  <p className="text-muted-foreground text-sm">
                    {invitation.role}
                  </p>
                </div>
                <div className="flex items-center gap-2">
                  <CopyInviteLink invitationId={invitation.id} />
                  <form action={cancelInvitationAction}>
                    <input
                      name="invitationId"
                      type="hidden"
                      value={invitation.id}
                    />
                    <Button size="sm" type="submit" variant="ghost">
                      Cancel
                    </Button>
                  </form>
                </div>
              </li>
            ))}
          </ul>
        </section>
      ) : null}
    </div>
  );
}
