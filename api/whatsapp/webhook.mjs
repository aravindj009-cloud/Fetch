      .filter(token => token.length >= 4);
    const lower = value.toLowerCase();
    if (itemTokens.some(token => lower.includes(token))) return true;
  }

  return false;
}

async function tryUniversalFetchCustomerRequest({
  customer,
  phone,
  userMessage,
  activeOrder = null,
} = {}) {
  if (!customer?.id || !shouldRunV9ForCustomerMessage(userMessage)) {
    return {
      handled: false,
      result: null,
    };
  }

  const normalizedPhone = normalizePhone(phone);

  /*
    Deterministic weather path. Do not ask for a location already present in
    the original request, and resolve a city-only follow-up from recent chat.
    Open-Meteo is used directly so this path does not depend on an LLM credit.
  */
  let recentForWeather = [];
  try {
    recentForWeather = await getRecentMessages(customer.id);
  } catch {}

  const recentWeatherLocationQuestion = Array.isArray(recentForWeather) &&
    [...recentForWeather].reverse().slice(0, 4).some((entry) => {
      const role = String(entry?.role || entry?.sender || "").toLowerCase();
      const message = String(entry?.message || entry?.content || "");
      return (!role || role === "assistant" || role === "bot") &&
        /(?:what city|which city|what area|city or area|location).{0,100}(?:weather|check)|(?:weather).{0,100}(?:what city|which city|what area|city or area|location)|couldn.t find that location|send the town or city name/i.test(message);
    });

  const explicitWeatherRequest =
    /\b(weather|forecast|temperature|will it rain|rain tomorrow|raining|humidity|wind speed)\b/i.test(userMessage);
  const naturalWeatherRequest =
    /\bhow\s+does\s+it\s+look(?:s)?(?:\s+like)?\b/i.test(userMessage) &&
    /\b(?:today|tomorrow|tonight|right now|now|this morning|this afternoon|this evening)\b/i.test(userMessage) &&
    /\b(?:in|for|at)\s+[a-z][a-z .'-]{1,60}\b/i.test(userMessage);
  const weatherRequest = explicitWeatherRequest || naturalWeatherRequest;
  const trimmedWeatherFollowUp = String(userMessage || "").trim();
  const clearNewIntent =
    /[?]/.test(trimmedWeatherFollowUp) ||
    /^(?:i(?:'m| am| need| want| plan| would| will)|please|help me|tell me|show me|find me|book|order|buy|plan|recommend|explain|what|how|when|where|why)\b/i.test(trimmedWeatherFollowUp) ||
    /\b(?:offsite|meeting|itinerary|trip|visit|visiting|prepare|preparing|github|repository|repositories|shopping|groceries|electrician|weather|forecast|temperature|order|delivery)\b/i.test(trimmedWeatherFollowUp);

  const shortLocationFollowUp = recentWeatherLocationQuestion &&
    !weatherRequest &&
    !clearNewIntent &&
    trimmedWeatherFollowUp.length >= 2 &&
    trimmedWeatherFollowUp.length <= 100 &&
    !/^(?:hi|hello|hey|thanks|thank you|ok|okay|yes|no|connected)$/i.test(trimmedWeatherFollowUp) &&
    /[a-z]/i.test(trimmedWeatherFollowUp);

  if (weatherRequest || shortLocationFollowUp) {
    const locationMatch = userMessage.match(
      /\b(?:in|for|at)\s+(.+?)(?=\s+(?:today|tomorrow|tonight|right\s+now|now|this\s+morning|this\s+afternoon|this\s+evening)\b|\?|$)/i
    );
    const previousWeatherRequest = Array.isArray(recentForWeather)
      ? [...recentForWeather].reverse().find((entry) =>
          /\b(weather|forecast|temperature|will it rain|rain tomorrow|raining)\b/i.test(
            String(entry?.message || entry?.content || "")
          )
        )
      : null;
    const previousLocationMatch = String(
      previousWeatherRequest?.message || previousWeatherRequest?.content || ""
    ).match(/\b(?:in|for|at)\s+(.+?)(?:\?|$)/i);
    const location = (weatherRequest
      ? locationMatch?.[1]
      : userMessage.trim())?.replace(/[?.!,]+$/g, "").trim()
      || previousLocationMatch?.[1]?.replace(/[?.!,]+$/g, "").trim();

    if (location) {
      try {
        const geoResponse = await fetch(
          "https://geocoding-api.open-meteo.com/v1/search?name=" +
          encodeURIComponent(location) + "&count=1&language=en&format=json"
        );
        const geo = await geoResponse.json();
        const place = geo?.results?.[0];
        if (place) {
          const forecastResponse = await fetch(
            "https://api.open-meteo.com/v1/forecast?latitude=" +
            encodeURIComponent(place.latitude) +
            "&longitude=" + encodeURIComponent(place.longitude) +
            "&current=temperature_2m,apparent_temperature,relative_humidity_2m,weather_code,wind_speed_10m" +
            "&daily=weather_code,temperature_2m_max,temperature_2m_min,precipitation_probability_max" +
            "&timezone=auto&forecast_days=2"
          );
          const forecast = await forecastResponse.json();
          const tomorrow = /tomorrow|next day/i.test(
            [userMessage, previousWeatherRequest?.message || ""].join(" ")
          );
          const index = tomorrow ? 1 : 0;
          const date = forecast?.daily?.time?.[index];
          const high = forecast?.daily?.temperature_2m_max?.[index];
          const low = forecast?.daily?.temperature_2m_min?.[index];
          const rain = forecast?.daily?.precipitation_probability_max?.[index];
          const weatherCode = forecast?.daily?.weather_code?.[index];
          const currentTemperature = forecast?.current?.temperature_2m;
          const feelsLike = forecast?.current?.apparent_temperature;
          const currentWeatherCode = forecast?.current?.weather_code;
          const windSpeed = forecast?.current?.wind_speed_10m;
          const descriptions = {
            0: "clear sky", 1: "mainly clear", 2: "partly cloudy", 3: "overcast",
            45: "foggy", 48: "foggy", 51: "light drizzle", 53: "drizzle",
            55: "heavy drizzle", 61: "light rain", 63: "rain", 65: "heavy rain",
            71: "light snow", 73: "snow", 75: "heavy snow", 80: "rain showers",
            81: "rain showers", 82: "heavy rain showers", 95: "thunderstorms",
            96: "thunderstorms with hail", 99: "thunderstorms with hail"
          };
          const dayLabel = tomorrow ? "Tomorrow" : "Today";
          const placeLabel = [place.name, place.admin1, place.country].filter(Boolean).join(", ");
          const currentDescription = descriptions[currentWeatherCode] || descriptions[weatherCode] || "conditions unavailable";
          const currentSummary = currentTemperature == null
            ? ""
            : " Current: " + Math.round(currentTemperature) + "°C" +
              (feelsLike == null ? "" : " (feels like " + Math.round(feelsLike) + "°C)") + ".";
          const windSummary = windSpeed == null ? "" : " Wind " + Math.round(windSpeed) + " km/h.";
          const reply = high == null
            ? "I found " + placeLabel + ", but the forecast is temporarily unavailable."
            : dayLabel + " in " + placeLabel + ": " + currentDescription + "." +
              currentSummary + windSummary +
              " High " + Math.round(high) + "°C / low " + Math.round(low) + "°C" +
              (rain == null ? "." : "; up to " + rain + "% chance of precipitation.") +
              "\n\nForecast source: Open-Meteo (https://open-meteo.com).";
          await saveMessage({ customerId: customer.id, orderId: null, phone: normalizedPhone, role: "user", message: userMessage });
          await saveMessage({ customerId: customer.id, orderId: null, phone: normalizedPhone, role: "assistant", message: reply });
          await sendWhatsAppMessage(normalizedPhone, reply);
          return { handled: true, result: { status: "completed", domain: "weather", message: reply } };
        }
        const reply = "I couldn't find that location. Please send the town or city name once more.";
        await sendWhatsAppMessage(normalizedPhone, reply);
        return { handled: true, result: { status: "needs_clarification", domain: "weather", message: reply } };
      } catch (weatherError) {
        console.error("FETCH WHATSAPP WEATHER ERROR:", weatherError?.message || weatherError);
        const reply = "I couldn't retrieve the forecast just now. Please try again shortly.";
        await sendWhatsAppMessage(normalizedPhone, reply);
        return { handled: true, result: { status: "failed", domain: "weather", message: reply } };
      }
    }
  }

  /*
    Deterministic management-offsite preparation response.
    This request is self-contained and must not inherit any pending weather
    clarification or require an LLM provider to be available. Voice messages
    still enter through the existing transcription path and reach this handler
    as text, so this does not change voice-note support.
  */
  const normalizedOffsiteRequest = String(userMessage || "").trim();
  if (
    /\b(?:management\s+off[- ]?site|off[- ]?site)\b/i.test(normalizedOffsiteRequest) &&
    /\b(?:prepare|preparing|should i|what should|things|checklist|tomorrow)\b/i.test(normalizedOffsiteRequest)
  ) {
    const reply = [
      "For tomorrow’s management offsite, I’d prepare these five things:",
      "",
      "1. **Your objective:** What decisions or outcomes should the group leave with?",
      "2. **A concise performance update:** Key KPIs, progress against targets, and the biggest gaps.",
      "3. **Top priorities:** The 2–3 issues that need leadership alignment, with evidence and options.",
      "4. **Risks and dependencies:** What could block delivery, what support you need, and the trade-offs.",
      "5. **Proposed actions:** Owners, deadlines, and the decisions you want recorded.",
      "",
      "Bring a one-page summary rather than a long presentation. Be ready to explain what changed, why it matters, what you recommend, and what decision you need. Check the agenda and attendee list tonight, and prepare two or three specific questions for the leadership team."
    ].join("\n");

    await saveMessage({
      customerId: customer.id,
      orderId: null,
      phone: normalizedPhone,      .filter(token => token.length >= 4);
    const lower = value.toLowerCase();
    if (itemTokens.some(token => lower.includes(token))) return true;
  }

  return false;
}

async function tryUniversalFetchCustomerRequest({
  customer,
  phone,
  userMessage,
  activeOrder = null,
} = {}) {
  if (!customer?.id || !shouldRunV9ForCustomerMessage(userMessage)) {
    return {
      handled: false,
      result: null,
    };
  }

  const normalizedPhone = normalizePhone(phone);

  /*
    Deterministic weather path. Do not ask for a location already present in
    the original request, and resolve a city-only follow-up from recent chat.
    Open-Meteo is used directly so this path does not depend on an LLM credit.
  */
  let recentForWeather = [];
  try {
    recentForWeather = await getRecentMessages(customer.id);
  } catch {}

  const recentWeatherLocationQuestion = Array.isArray(recentForWeather) &&
    [...recentForWeather].reverse().slice(0, 4).some((entry) => {
      const role = String(entry?.role || entry?.sender || "").toLowerCase();
      const message = String(entry?.message || entry?.content || "");
      return (!role || role === "assistant" || role === "bot") &&
        /(?:what city|which city|what area|city or area|location).{0,100}(?:weather|check)|(?:weather).{0,100}(?:what city|which city|what area|city or area|location)|couldn.t find that location|send the town or city name/i.test(message);
    });

  const weatherRequest = /\b(weather|forecast|temperature|will it rain|rain tomorrow|raining)\b/i.test(userMessage);
  const trimmedWeatherFollowUp = String(userMessage || "").trim();
  const clearNewIntent =
    /[?]/.test(trimmedWeatherFollowUp) ||
    /^(?:i(?:'m| am| need| want| plan| would| will)|please|help me|tell me|show me|find me|book|order|buy|plan|recommend|explain|what|how|when|where|why)\b/i.test(trimmedWeatherFollowUp) ||
    /\b(?:offsite|meeting|itinerary|trip|visit|visiting|prepare|preparing|github|repository|repositories|shopping|groceries|electrician|weather|forecast|temperature|order|delivery)\b/i.test(trimmedWeatherFollowUp);

  const shortLocationFollowUp = recentWeatherLocationQuestion &&
    !weatherRequest &&
    !clearNewIntent &&
    trimmedWeatherFollowUp.length >= 2 &&
    trimmedWeatherFollowUp.length <= 100 &&
    !/^(?:hi|hello|hey|thanks|thank you|ok|okay|yes|no|connected)$/i.test(trimmedWeatherFollowUp) &&
    /[a-z]/i.test(trimmedWeatherFollowUp);

  if (weatherRequest || shortLocationFollowUp) {
    const locationMatch = userMessage.match(/\b(?:in|for|at)\s+(.+?)(?:\?|$)/i);
    const previousWeatherRequest = Array.isArray(recentForWeather)
      ? [...recentForWeather].reverse().find((entry) =>
          /\b(weather|forecast|temperature|will it rain|rain tomorrow|raining)\b/i.test(
            String(entry?.message || entry?.content || "")
          )
        )
      : null;
    const previousLocationMatch = String(
      previousWeatherRequest?.message || previousWeatherRequest?.content || ""
    ).match(/\b(?:in|for|at)\s+(.+?)(?:\?|$)/i);
    const location = (weatherRequest
      ? locationMatch?.[1]
      : userMessage.trim())?.replace(/[?.!,]+$/g, "").trim()
      || previousLocationMatch?.[1]?.replace(/[?.!,]+$/g, "").trim();

    if (location) {
      try {
        const geoResponse = await fetch(
          "https://geocoding-api.open-meteo.com/v1/search?name=" +
          encodeURIComponent(location) + "&count=1&language=en&format=json"
        );
        const geo = await geoResponse.json();
        const place = geo?.results?.[0];
        if (place) {
          const forecastResponse = await fetch(
            "https://api.open-meteo.com/v1/forecast?latitude=" +
            encodeURIComponent(place.latitude) +
            "&longitude=" + encodeURIComponent(place.longitude) +
            "&daily=weather_code,temperature_2m_max,temperature_2m_min,precipitation_probability_max" +
            "&timezone=auto&forecast_days=2"
          );
          const forecast = await forecastResponse.json();
          const tomorrow = /tomorrow|next day/i.test(
            [userMessage, previousWeatherRequest?.message || ""].join(" ")
          );
          const index = tomorrow ? 1 : 0;
          const date = forecast?.daily?.time?.[index];
          const high = forecast?.daily?.temperature_2m_max?.[index];
          const low = forecast?.daily?.temperature_2m_min?.[index];
          const rain = forecast?.daily?.precipitation_probability_max?.[index];
          const weatherCode = forecast?.daily?.weather_code?.[index];
          const descriptions = {
            0: "clear sky", 1: "mainly clear", 2: "partly cloudy", 3: "overcast",
            45: "foggy", 48: "foggy", 51: "light drizzle", 53: "drizzle",
            55: "heavy drizzle", 61: "light rain", 63: "rain", 65: "heavy rain",
            71: "light snow", 73: "snow", 75: "heavy snow", 80: "rain showers",
            81: "rain showers", 82: "heavy rain showers", 95: "thunderstorms",
            96: "thunderstorms with hail", 99: "thunderstorms with hail"
          };
          const dayLabel = tomorrow ? "Tomorrow" : "Today";
          const reply = high == null
            ? "I found " + [place.name, place.admin1, place.country].filter(Boolean).join(", ") + ", but the forecast is temporarily unavailable."
            : dayLabel + " in " +
              [place.name, place.admin1, place.country].filter(Boolean).join(", ") +
              ": " + (descriptions[weatherCode] || "conditions unavailable") +
              ", " + Math.round(low) + "–" + Math.round(high) + "°C" +
              (rain == null ? "." : ", up to " + rain + "% chance of precipitation.") +
              "\n\nForecast source: Open-Meteo.";
          await saveMessage({ customerId: customer.id, orderId: null, phone: normalizedPhone, role: "user", message: userMessage });
          await saveMessage({ customerId: customer.id, orderId: null, phone: normalizedPhone, role: "assistant", message: reply });
          await sendWhatsAppMessage(normalizedPhone, reply);
          return { handled: true, result: { status: "completed", domain: "weather", message: reply } };
        }
        const reply = "I couldn't find that location. Please send the town or city name once more.";
        await sendWhatsAppMessage(normalizedPhone, reply);
        return { handled: true, result: { status: "needs_clarification", domain: "weather", message: reply } };
      } catch (weatherError) {
        console.error("FETCH WHATSAPP WEATHER ERROR:", weatherError?.message || weatherError);
        const reply = "I couldn't retrieve the forecast just now. Please try again shortly.";
        await sendWhatsAppMessage(normalizedPhone, reply);
        return { handled: true, result: { status: "failed", domain: "weather", message: reply } };
      }
    }
  }

  /*
    Deterministic management-offsite preparation response.
    This request is self-contained and must not inherit any pending weather
    clarification or require an LLM provider to be available. Voice messages
    still enter through the existing transcription path and reach this handler
    as text, so this does not change voice-note support.
  */
  const normalizedOffsiteRequest = String(userMessage || "").trim();
  if (
    /\b(?:management\s+off[- ]?site|off[- ]?site)\b/i.test(normalizedOffsiteRequest) &&
    /\b(?:prepare|preparing|should i|what should|things|checklist|tomorrow)\b/i.test(normalizedOffsiteRequest)
  ) {
    const reply = [
      "For tomorrow’s management offsite, I’d prepare these five things:",
      "",
      "1. **Your objective:** What decisions or outcomes should the group leave with?",
      "2. **A concise performance update:** Key KPIs, progress against targets, and the biggest gaps.",
      "3. **Top priorities:** The 2–3 issues that need leadership alignment, with evidence and options.",
      "4. **Risks and dependencies:** What could block delivery, what support you need, and the trade-offs.",
      "5. **Proposed actions:** Owners, deadlines, and the decisions you want recorded.",
      "",
      "Bring a one-page summary rather than a long presentation. Be ready to explain what changed, why it matters, what you recommend, and what decision you need. Check the agenda and attendee list tonight, and prepare two or three specific questions for the leadership team."
    ].join("\n");

    await saveMessage({
      customerId: customer.id,
      orderId: null,
      phone: normalizedPhone,