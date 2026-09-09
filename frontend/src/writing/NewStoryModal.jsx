import { NamePromptModal } from "../components/NamePromptModal.jsx";

export function NewStoryModal({ open, onClose, onCreate }) {
  return (
    <NamePromptModal
      open={open}
      onClose={onClose}
      onCreate={onCreate}
      heading="Name your new story"
      description="You can rename your story from the sidebar at any time"
      placeholder="Story name"
      inputLabel="Story name"
      submitLabel="Create story"
      dialogLabel="Close new story dialog"
    />
  );
}
