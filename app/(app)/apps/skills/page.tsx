import { Suspense } from "react";
import { Skills } from "@/components/dashboard/screens/skills";

export const metadata = { title: "Skills" };

export default function SkillsPage() {
  // The screen reads the skill open from the address, which only the browser has.
  return <Suspense><Skills /></Suspense>;
}
