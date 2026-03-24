// src/handlers/places.js

export async function handlePlacesAutocomplete(request, env) {
  const url = new URL(request.url);
  const q = url.searchParams.get("q") || "";

  if (q.length < 3) return { data: [] };

  const apiUrl =
    "https://maps.googleapis.com/maps/api/place/autocomplete/json?" +
    new URLSearchParams({
      input: q,
      types: "geocode",
      language: "tr",
      key: env.GOOGLE_PLACES_KEY,
    });

  const res = await fetch(apiUrl);
  const json = await res.json();

  if (json.status !== "OK" && json.status !== "ZERO_RESULTS") {
    return { error: json.error_message || `Google API error: ${json.status}`, status: 502 };
  }

  const predictions = (json.predictions || []).map((p) => ({
    placeId: p.place_id,
    description: p.description,
  }));

  return { data: predictions };
}

export async function handlePlacesDetails(request, env) {
  const url = new URL(request.url);
  const placeId = url.searchParams.get("placeId");

  if (!placeId) return { error: "Missing placeId", status: 400 };

  const apiUrl =
    "https://maps.googleapis.com/maps/api/place/details/json?" +
    new URLSearchParams({
      place_id: placeId,
      fields: "geometry,formatted_address,name",
      key: env.GOOGLE_PLACES_KEY,
    });

  const res = await fetch(apiUrl);
  const json = await res.json();

  if (json.status !== "OK") {
    return { error: json.error_message || `Google API error: ${json.status}`, status: 502 };
  }

  const result = json.result;
  return {
    data: {
      name: result.name,
      formattedAddress: result.formatted_address,
      lat: result.geometry.location.lat,
      lng: result.geometry.location.lng,
    },
  };
}
