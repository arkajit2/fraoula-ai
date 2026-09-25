import { createFileRoute } from "@tanstack/react-router";
import { ChatView } from "@/components/chat/ChatView";

export const Route = createFileRoute("/_authenticated/chat/$conversationId")({
  head: () => ({
    meta: [
      { title: "Chat · Fraoula AI" },
      { name: "description", content: "Your AI conversation history in Fraoula AI." },
      { property: "og:title", content: "Chat · Fraoula AI" },
      { property: "og:description", content: "Your AI conversation history in Fraoula AI." },
    ],
  }),
  component: ChatPage,
});

function ChatPage() {
  const { conversationId } = Route.useParams();
  return <ChatView key={conversationId} conversationId={conversationId} />;
}
