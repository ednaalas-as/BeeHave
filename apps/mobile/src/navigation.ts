import { Feather } from "@expo/vector-icons";
import React from "react";

export type Tab =
  | "Dashboard"
  | "Activity"
  | "Detection"
  | "Recordings"
  | "Edge Device"
  | "Settings";

export type Detail = {
  kind: "detection" | "recording";
  device: string;
  id: string;
} | null;

export const tabs: {
  label: Tab;
  title: string;
  icon: React.ComponentProps<typeof Feather>["name"];
}[] = [
  { label: "Dashboard", title: "Home", icon: "grid" },
  { label: "Activity", title: "Activity", icon: "activity" },
  { label: "Detection", title: "Detections", icon: "radio" },
  { label: "Recordings", title: "Audio", icon: "headphones" },
  { label: "Edge Device", title: "Devices", icon: "cpu" },
];
