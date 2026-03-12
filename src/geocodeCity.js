// Free geocoding via OpenStreetMap Nominatim
export async function geocodeCity(city) {
    if (!city || city.length < 2) {
      throw new Error('Invalid city name');
    }
  
    const url =
      'https://nominatim.openstreetmap.org/search?' +
      new URLSearchParams({
        q: city,
        format: 'json',
        limit: 1,
      });
  
    const res = await fetch(url, {
      headers: {
        // REQUIRED by Nominatim usage policy
        'User-Agent': 'CelestialApp/1.0 (contact@yourdomain.com)',
      },
    });
  
    if (!res.ok) {
      throw new Error('Geocoding failed');
    }
  
    const data = await res.json();
  
    if (!data.length) {
      throw new Error('City not found');
    }
  
    return {
      latitude: parseFloat(data[0].lat),
      longitude: parseFloat(data[0].lon),
      displayName: data[0].display_name,
    };
  }
  