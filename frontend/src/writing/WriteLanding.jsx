export function WriteLanding({ openingMessage }) {
  if (!openingMessage) return null;

  return (
    <section className="pointer-events-none absolute inset-0 z-10 flex items-center justify-center px-4 pb-[12vh] pt-20 sm:px-8 lg:px-10">
      <div className="mx-auto flex w-full max-w-[760px] flex-col items-center">
        <div className="text-balance text-center text-[28px] font-medium leading-tight tracking-[-0.02em] text-neutral-200 sm:text-[42px]">
          {openingMessage}
        </div>
      </div>
    </section>
  );
}
