/** Python's round(): halves go to the even neighbour, so 14.5 is 14 and 2.5 is 2 (weather_service.py rounds every reading). */
export function roundHalfEven(value) {
    const floor = Math.floor(value);
    const rest = value - floor;
    return rest > 0.5 ? floor + 1 : rest < 0.5 ? floor : floor % 2 === 0 ? floor : floor + 1;
}
/** "70 percent chance" in a condition, else 0 (weather_service.py:793-795). Current conditions rarely say it. */
export function precipFromCondition(condition) {
    const match = /(\d+)\s*percent\s*chance/i.exec(condition ?? "");
    return match ? Number(match[1]) : 0;
}
function period(hour) {
    if (hour < 12)
        return `this morning (${hour}am)`;
    if (hour === 12)
        return "at noon";
    if (hour < 17)
        return `this afternoon (${hour - 12}pm)`;
    if (hour < 21)
        return `this evening (${hour - 12}pm)`;
    return `tonight (${hour - 12}pm)`;
}
function sentence(items) {
    return items.length === 1 ? `Bring a ${items[0]}` : `Bring: ${items.slice(0, -1).join(", ")} and ${items.at(-1)}`;
}
/**
 * get_recommendations (recommendation_engine.py:14-81). Environment Canada gives no feels-like
 * temperature, so the rules read the observed temperature and the summary never says "feels like".
 * One intended difference: wind comes from the observation's km/h, where Bernie read a wind_kph key
 * that nothing set, so his windproof rule never fired.
 */
export function recommend(input) {
    const { tempC: temp, windKmh, precipProbPct } = input;
    const clothing = [];
    const alerts = [];
    let severity = "low";
    if (temp < -10) {
        clothing.push("heavy winter coat", "hat", "gloves", "warm boots");
        severity = "high";
    }
    else if (temp < 0) {
        clothing.push("winter coat", "gloves");
        severity = "medium";
    }
    else if (temp < 8) {
        clothing.push("jacket");
    }
    else if (temp < 15) {
        clothing.push("light jacket or layer");
    }
    if (windKmh > 40) {
        clothing.push("windproof layer");
        if (severity === "low")
            severity = "medium";
    }
    if (precipProbPct > 60) {
        clothing.push("umbrella");
        if (severity === "low")
            severity = "medium";
    }
    const rainy = input.hourly.find((hour) => hour.precipProbPct > 60);
    if (rainy)
        alerts.push(`Rain likely ${period(rainy.hour)} (~${rainy.precipProbPct}% chance)`);
    else if (precipProbPct < 20)
        alerts.push("Dry day expected — good for being outside");
    const summary = `${input.condition ?? "—"} · ${temp}°C.${clothing.length ? ` ${sentence(clothing)}.` : ""}`;
    return { summary, clothing, alerts, severity };
}
