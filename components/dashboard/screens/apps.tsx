"use client";

import { usePathname, useRouter } from "next/navigation";
import type { ReactNode } from "react";
import { useQuery } from "@/client/react";
import { api } from "@/convex/_generated/api";
import { useSession } from "@/lib/session";
import { Tabs, TabsContent, TabsList, TabsTrigger } from "@/components/ui/tabs";
import { ListSkeleton, Page, PageInPage, Section } from "../common";
import { Connectors } from "./connectors";
import { KeyRow } from "./settings";

const TABS = [
  { value: "connectors", label: "Connectors" },
  { value: "skills", label: "Skills" },
] as const;

/**
 * Apps & skills: what Perry can reach (the accounts it connects through
 * Composio) and how he does things (his skills), a tab each, each at its own
 * address under /apps.
 */
export function AppsShell({ children }: { children: ReactNode }) {
  const pathname = usePathname();
  const router = useRouter();
  const tab = TABS.find((item) => pathname.startsWith(`/apps/${item.value}`))?.value ?? "connectors";
  return (
    <Page title="Apps & skills" wide>
      <Tabs value={tab} onValueChange={(value) => router.push(`/apps/${value}`)}>
        <TabsList variant="line" className="mb-6 w-full justify-start gap-4 border-b pb-0 [&>button]:flex-none [&>button]:px-0 [&>button]:pb-2.5">
          {TABS.map((item) => <TabsTrigger key={item.value} value={item.value}>{item.label}</TabsTrigger>)}
        </TabsList>
        <TabsContent value={tab}><PageInPage>{children}</PageInPage></TabsContent>
      </Tabs>
    </Page>
  );
}

/**
 * The Connectors tab: the connectors themselves, and below them the Composio
 * key they need, which used to be under Settings › Keys. Saving or clearing
 * the key starts the connectors over, so they read it at once.
 */
export function AppsConnectors() {
  const { dashboardKey } = useSession();
  const composio = useQuery(api.dashboard.getKeys, { key: dashboardKey })?.find((entry) => entry.name === "COMPOSIO_API_KEY");
  if (!composio) return <ListSkeleton />;
  return (
    <>
      <Connectors key={`${composio.source}${composio.preview ?? ""}`} />
      <Section title="Composio">
        <KeyRow name="COMPOSIO_API_KEY" className="pt-0" />
      </Section>
    </>
  );
}
