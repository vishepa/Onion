const API_KEY = process.env.GROQ_API_KEY;
const MODEL = 'openai/gpt-oss-120b';
const API_URL = 'https://api.groq.com/openai/v1/chat/completions';

// AI prompt
const SYSTEM_PROMPT = `You are a food accessibility analyst for Vancouver, BC.
You are given statistics about a dissemination area and its nearby food assets
(grocery stores, community gardens, farmers markets, etc.) based on walking distance.

Write a 3-4 sentence summary for a {persona}.

If persona is "planner":
- Use policy-relevant language
- Highlight gaps, underserved populations, and infrastructure needs
- Reference specific metrics

If persona is "resident":
- Use plain, accessible language
- Focus on what this means for daily life
- Mention nearby food options and what's missing

Rules:
- Only reference data you are given. Do not fabricate statistics.
- Be specific, mention actual numbers from the data.
- If relevant, include recent local news about this Vancouver neighbourhood, prioritize food access news (grocery openings/closures, community food programs, farmers markets)
  but also include relevant infrastructure news (transit changes, new developments, housing projects, community services) that could impact food accessibility.
- If proposed/simulated food assets are listed, comment on how they would improve or change this area's food accessibility compared to the current state.
- Keep it concise (3-4 sentences max).`;

const cache = new Map();

// Reverse geocode lat/lng to a street name via Nominatim
async function reverseGeocode(lat, lng) {
  try {
    const res = await fetch(
      `https://nominatim.openstreetmap.org/reverse?lat=${lat}&lon=${lng}&format=json&zoom=17`,
      { headers: { 'User-Agent': 'VancouverFoodAccessApp/1.0' } }
    );
    const data = await res.json();
    return data.address?.road || data.display_name?.split(',')[0] || `${lat.toFixed(4)}, ${lng.toFixed(4)}`;
  } catch {
    return `${lat.toFixed(4)}, ${lng.toFixed(4)}`;
  }
}

export async function generateDASummary(stats, nearbyFoodAssets, persona, simulatedAssets = []) {
  const cacheKey = simulatedAssets.length > 0
    ? `${stats.dauid}-${persona}-sim-${simulatedAssets.length}`
    : `${stats.dauid}-${persona}`;
  if (cache.has(cacheKey)) {
    return cache.get(cacheKey);
  }

  let dataContext = `
Dissemination Area: ${stats.dauid}
Population Density: ${stats.population_density_per_km2} per km²
Average Household Size: ${stats.avg_household_size}
Median Household Income: $${Number(stats.median_household_income).toLocaleString()}
Low Income (LIM-AT): ${stats.pct_low_income_lim_at}%
Shelter Cost 30%+: ${stats.pct_shelter_cost_30pct_plus}%
Commute by Car: ${stats.pct_commute_car}%
Commute by Transit: ${stats.pct_commute_transit}%
Commute by Walking: ${stats.pct_commute_walk}%

Nearby Food Assets (by walking distance):
${nearbyFoodAssets.length === 0
    ? 'No food assets within walking distance.'
    : nearbyFoodAssets.map(f =>
        `- ${f.name} (${f.category}) — ${f.range_seconds / 60} min walk`
      ).join('\n')
  }
`;

  if (simulatedAssets.length > 0) {
    // Geocode all simulated assets in parallel
    const geocoded = await Promise.all(
      simulatedAssets.map(async (a) => {
        const street = await reverseGeocode(a.lat, a.lng);
        return `- ${a.category} near ${street}`;
      })
    );
    dataContext += `
Proposed Food Assets (not yet built — part of a simulation):
${geocoded.join('\n')}
`;
  }

  const prompt = SYSTEM_PROMPT.replace('{persona}', persona);

  const res = await fetch(API_URL, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      'Authorization': `Bearer ${API_KEY}`,
    },
    body: JSON.stringify({
      model: MODEL,
      messages: [
        { role: 'system', content: prompt },
        { role: 'user', content: dataContext },
      ],
      temperature: 0.7,
      // gpt-oss is a reasoning model: reasoning tokens count toward the limit,
      // so keep effort low and leave headroom for the 3-4 sentence summary
      reasoning_effort: 'low',
      include_reasoning: false,
      max_completion_tokens: 1024,
    })
  });

  const data = await res.json();

  if (!res.ok) {
    throw new Error(data.error?.message || 'Groq API request failed');
  }

  const summary = data.choices?.[0]?.message?.content || 'No summary generated.';

  cache.set(cacheKey, summary);

  return summary;
}

export function clearCacheEntry(dauid, persona) {
  cache.delete(`${dauid}-${persona}`);
}
