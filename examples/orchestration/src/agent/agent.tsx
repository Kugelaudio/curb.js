import { Agent, Skill, Skills, SystemPrompt, defineAgent } from "curb";
import { kugelaudio } from "curb/providers";

export function App() {
  return (
    <Agent stt={kugelaudio.stt({ language: "en" })} tts={kugelaudio.tts({ language: "en" })}>
      <SystemPrompt>You book viewings for Example Homes. Read the booking skill silently before you ask anything.</SystemPrompt>
      <Skills>
        <Skill path="/booking" description="Use for every viewing request: the ordered booking flow.">
          Booking
        </Skill>
      </Skills>
    </Agent>
  );
}

export const agent = defineAgent({
  app: App,
  // Exact words, no model call. `info` carries what the caller's page sent (`client.*`).
  firstTurn: {
    say: (info) => {
      const listing = info["client.listing"];
      return typeof listing === "string" ? `Example Homes, about ${listing}?` : "Example Homes, how can I help?";
    },
  },
  timeZone: "Europe/Berlin",
  maxSteps: 4,
  maxTranscriptMessages: 30,
  maxLoadedSkills: 1,
});
