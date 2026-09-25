import { createFileRoute } from "@tanstack/react-router";
import { ChatView } from "@/components/chat/ChatView";

export const Route = createFileRoute("/_authenticated/chat/")({
  head: () => ({
    meta: [
      { title: "New chat · Fraoula AI" },
      { name: "description", content: "Start a new AI conversation with Fraoula AI." },
      { property: "og:title", content: "New chat · Fraoula AI" },
      { property: "og:description", content: "Start a new AI conversation with Fraoula AI." },
    ],
  }),
  component: () => <ChatView conversationId={null} />,
});
