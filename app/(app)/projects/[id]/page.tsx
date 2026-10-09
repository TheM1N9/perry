import { Suspense } from "react";
import { ProjectScreen } from "@/components/dashboard/screens/project";

export const metadata = { title: "Project" };

export default function ProjectPage() {
  // The screen reads the project from the address, which only the browser has.
  return <Suspense><ProjectScreen /></Suspense>;
}
