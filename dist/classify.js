import { addDays } from "./week.js";
/** Bernie's school_calendar.py word lists. They are regional, so callers may pass their own. */
export const DEFAULT_VOCABULARY = {
    alwaysSignal: new RegExp(String.raw `\b(tests?|exams?|quiz(?:zes)?|ica|midterms?|finals|final (?:exams?|tests?|assessments?)|` +
        String.raw `no school|pd day|early dismissal|closure|holiday|birthday|anniversary|` +
        String.raw `concert|recital|audition|performance|showcase|tournament|` +
        String.raw `field trip|trip|photo|picture day|interviews?|liturgy|curriculum night|report cards?|` +
        String.raw `appointment|appt|dentist|doctor|dr|ortho\w*|clinic|physio\w*|dietit?c?ian|vet)\b`, "i"),
    uniform: /\b(uniform|dress|p\.?e\.?|phys(?:ical)?\s+ed|spirit|regular)\b/i,
    routineUniform: /^\s*((p\.?e\.?|regular|spirit)(\s+(uniform|gear))?|uniform)\s*$/i,
};
/**
 * Routine is the week's normal rhythm: school classes and homework, plain uniforms,
 * and on-time repeats of timed family events. Signal titles, special uniforms,
 * one-offs, all-day family events and moved repeats are never routine.
 */
export function classifyEvent(event, vocabulary = DEFAULT_VOCABULARY) {
    const signal = vocabulary.alwaysSignal.test(event.title);
    if (event.calendarKind === "school") {
        if (!event.allDay)
            return { routine: !signal };
        const dueDate = addDays(event.end, -1);
        if (vocabulary.uniform.test(event.title)) {
            return { routine: !signal && vocabulary.routineUniform.test(event.title), uniform: { dueDate } };
        }
        return { routine: !signal, homework: { dueDate } };
    }
    const onTimeRepeat = !event.allDay && event.recurringEventId !== undefined && (event.originalStart === undefined || event.originalStart === event.start);
    return { routine: !signal && onTimeRepeat };
}
/** "8:05 AM" in `timezone`, with a plain space whatever the ICU version puts before the day period. */
export function clockTime(start, timezone) {
    const clock = new Intl.DateTimeFormat("en-US", { timeZone: timezone, hour: "numeric", minute: "2-digit", hour12: true });
    const parts = Object.fromEntries(clock.formatToParts(Date.parse(start)).map((part) => [part.type, part.value]));
    return `${parts.hour}:${parts.minute} ${parts.dayPeriod}`;
}
/** One plain-text line of routine timed family events; school rows are left out. The renderer adds any styling. */
export function usualLine(events, timezone, vocabulary = DEFAULT_VOCABULARY) {
    const time = (start) => clockTime(start, timezone);
    const bits = events
        .filter((event) => !event.allDay && event.calendarKind !== "school" && classifyEvent(event, vocabulary).routine)
        .sort((a, b) => Date.parse(a.start) - Date.parse(b.start))
        .map((event) => `${event.title} ${time(event.start)}`);
    return bits.length > 0 ? `Usual: ${bits.join(" · ")}` : undefined;
}
