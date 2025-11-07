import logo from './logo.svg';
import './App.css';

import React, { useState, useEffect, useCallback, useMemo } from 'react';
import { ChevronRight, Zap, Trophy, TrendingUp, Cpu } from 'lucide-react';

// The base URL for the ESPN API endpoint (used by the ranking/modal feature for LIVE data)
const API_URL = 'https://site.api.espn.com/apis/site/v2/sports/football/nfl/scoreboard';

// --- Step 1: Data Transformation and Winner Determination ---
const transformEvents = (data) => {
  if (!data || !data.events) return [];

  return data.events.map(event => {
    const competition = event.competitions?.[0];
    const competitors = competition?.competitors;
    // Assuming the primary odds object is the first item in the odds array
    const oddsData = competition?.odds?.[0]; 

    if (!competitors || competitors.length < 2) return null; 

    // Find teams based on home/away status
    const away = competitors.find(c => c.homeAway === 'away');
    const home = competitors.find(c => c.homeAway === 'home');

    const awayTeamAbbr = away?.team?.abbreviation || 'AWY';
    const homeTeamAbbr = home?.team?.abbreviation || 'HOM';

    // Get odds as strings for display
    const awayOddsStr = oddsData?.awayTeamOdds?.moneyLine || null;
    const homeOddsStr = oddsData?.homeTeamOdds?.moneyLine || null;

    // Convert odds to numbers for calculation/comparison. NaN if parsing fails.
    const awayLineNum = awayOddsStr ? parseInt(awayOddsStr, 10) : NaN;
    const homeLineNum = homeOddsStr ? parseInt(homeOddsStr, 10) : NaN;

    let expectedWinner = 'Toss-Up / N/A';
    let winnerLine = NaN; // Numeric line for sorting

    if (!isNaN(awayLineNum) && !isNaN(homeLineNum)) {
        if (awayLineNum < 0 || homeLineNum < 0) {
            // Standard favorite logic: the team with the lower (more negative) moneyline is the favorite
            if (awayLineNum < homeLineNum) {
                expectedWinner = awayTeamAbbr;
                winnerLine = awayLineNum;
            } else {
                expectedWinner = homeTeamAbbr;
                winnerLine = homeLineNum;
            }
        } else if (awayLineNum > 0 && homeLineNum > 0) {
            // If both are underdogs (positive), the one with the lowest positive number is the slight favorite
            if (awayLineNum < homeLineNum) {
                expectedWinner = awayTeamAbbr;
                winnerLine = awayLineNum;
            } else {
                expectedWinner = homeTeamAbbr;
                winnerLine = homeLineNum;
            }
        }
    }

    return {
      id: event.id,
      awayTeam: awayTeamAbbr,
      homeTeam: homeTeamAbbr,
      awayOdds: awayOddsStr,
      homeOdds: homeOddsStr,
      expectedWinner: expectedWinner,
      winnerLine: winnerLine, // Use this numeric value for ranking
      status: event.status.type.detail,
      confidenceRank: null, // Placeholder for ranking
    };
  }).filter(item => item !== null); // Filter out any events that failed to parse
};

// --- Step 2: Ranking Logic (Reversed) ---
const rankEvents = (events) => {
    // 1. Filter events that have a valid winnerLine for ranking
    const rankableEvents = events.filter(e => e.expectedWinner !== 'Toss-Up / N/A' && !isNaN(e.winnerLine));

    // 2. Sort the rankable events: lowest (most negative) winnerLine is index 0 (strongest favorite)
    // The sort order remains ascending (strongest favorite first).
    rankableEvents.sort((a, b) => a.winnerLine - b.winnerLine);

    // 3. Assign unique rank (1 to N, but reversed)
    const totalGames = rankableEvents.length;

    rankableEvents.forEach((event, index) => {
        // Assign rank: 
        // index 0 (strongest favorite) gets rank: totalGames - 0 = N (Max Rank)
        // index N-1 (weakest favorite) gets rank: totalGames - (N-1) = 1 (Min Rank)
        event.confidenceRank = totalGames - index;
    });

    return rankableEvents; 
};

// --- Main App Component ---
const App = () => {
    // --- State for Modal/Ranking Feature (Original Second Half) ---
    const [events, setEvents] = useState([]); // Raw/Ranked events for Modal
    const [isLoading, setIsLoading] = useState(false); // Loading for Modal fetch
    const [modalOpen, setModalOpen] = useState(false);
    const [networkError, setNetworkError] = useState(null); 

    // --- State for Schedule Fetcher Feature (Original First Half) ---
    const currentYear = new Date().getFullYear();
    const [year, setYear] = useState(null); // Initial year is null to trigger scoreboard
    const [week, setWeek] = useState(null); 
    const [queryTrigger, setQueryTrigger] = useState(0); 
    const [games, setGames] = useState([]); // Game data for main schedule view
    const [loading, setLoading] = useState(false); // Loading for Schedule fetch
    const [error, setError] = useState(null);
    const [apiUrlUsed, setApiUrlUsed] = useState('');
    const [hasAttemptedQuery, setHasAttemptedQuery] = useState(false);
    const [showDebug, setShowDebug] = useState(false);
    
    // Define targetYear in App scope
    const targetYear = year !== null ? year : currentYear;

    // Constant for the fast initial load API (Scoreboard)
    const SCOREBOARD_URL = 'https://sports.core.api.espn.com/v2/sports/football/leagues/nfl/events';

    // Dynamically calculate the requested API URL for the main schedule view
    const requestedUrl = useMemo(() => 
        (year && week)
            ? `https://sports.core.api.espn.com/v2/sports/football/leagues/nfl/seasons/${year}/types/2/weeks/${week}/events`
            : SCOREBOARD_URL, // Use scoreboard URL if year/week not set (initial load)
    [year, week]);

    // Dynamically calculate the URL for the Ranking Modal fetch
    const rankingUrl = useMemo(() => 
        (year && week)
            ? `https://sports.core.api.espn.com/v2/sports/football/leagues/nfl/seasons/${year}/types/2/weeks/${week}/events`
            : API_URL, // API_URL is the simple /site/v2/scoreboard (for live ranking)
    [year, week]);


    /**
     * Helper function to extract structured team data and scores from an array of events.
     */
    const extractTeams = useCallback((events) => {
        const extractedGames = [];

        events.forEach(event => {
            // FIX: Access competition reliably from event
            const competition = event.competitions && event.competitions.length > 0 ? event.competitions[0] : null;

            if (!competition) return;

            const competitors = competition.competitors;
            if (!competitors || competitors.length < 2) return;

            let homeData = { debugRecordUrl: 'N/A' };
            let awayData = { debugRecordUrl: 'N/A' };
            
            // --- ODDS EXTRACTION (COMPREHENSIVE LOGIC) ---
            let oddsMap = {}; // Map team ID to moneyLine value (e.g., { '12': '+150' })
            const oddsList = competition.odds;
            
            // Find competitors for ID mapping
            const awayComp = competitors.find(c => c.homeAway === 'away');
            const homeComp = competitors.find(c => c.homeAway === 'home');
            
            // Helper to format Moneyline value
            const formatMoneyLine = (ml) => (ml !== null && ml !== undefined ? (ml > 0 ? '+' : '') + ml : null);

            if (oddsList && oddsList.length > 0) {
                const primaryOdds = oddsList[0];
                
                // Determine the source of the detailed odds. 
                const oddsSource = (primaryOdds.items && primaryOdds.items.length > 0) 
                    ? primaryOdds.items[0] 
                    : primaryOdds; // Use primary object as source if 'items' array is missing/empty

                // --- Attempt 1: Check the determined oddsSource for detailed team odds ---
                if (oddsSource) {
                    // AWAY TEAM
                    if (awayComp && awayComp.team?.id && oddsSource.awayTeamOdds) {
                        const awayOddsObject = oddsSource.awayTeamOdds;
                        // Check for PascalCase 'Moneyline' first, then camelCase 'moneyLine'
                        const awayML = awayOddsObject.Moneyline !== undefined 
                            ? awayOddsObject.Moneyline 
                            : awayOddsObject.moneyLine; 
                        
                        if (awayML !== undefined) oddsMap[awayComp.team.id] = formatMoneyLine(awayML);
                    }
                    
                    // HOME TEAM
                    if (homeComp && homeComp.team?.id && oddsSource.homeTeamOdds) {
                        const homeOddsObject = oddsSource.homeTeamOdds;
                        // Check for PascalCase 'Moneyline' first, then camelCase 'moneyLine'
                        const homeML = homeOddsObject.Moneyline !== undefined 
                            ? homeOddsObject.Moneyline 
                            : homeOddsObject.moneyLine; 
                            
                        if (homeML !== undefined) oddsMap[homeComp.team.id] = formatMoneyLine(homeML);
                    }
                }

                // --- Attempt 2: Simple moneyLine array structure (Fallback) ---
                if (Object.keys(oddsMap).length === 0 && primaryOdds.moneyLine && Array.isArray(primaryOdds.moneyLine)) {
                    primaryOdds.moneyLine.forEach(ml => {
                        if (ml.targetId && ml.moneyLine !== undefined) {
                            oddsMap[ml.targetId] = formatMoneyLine(ml.moneyLine);
                        }
                    });
                }
            }
            // --- END ODDS EXTRACTION ---
            
            
            competitors.forEach(comp => {
                const teamName = comp.team?.displayName || comp.team?.shortDisplayName || comp.team?.abbreviation || 'Unknown Team';
                const teamNameAbr = comp.team?.abbreviation;
                const teamLogo = comp.team?.logos?.[0]?.href || ''; 
                const teamId = comp.team?.id;
                
                // Get Odds based on team ID, default to 'N/A'
                let teamOdds = teamId && oddsMap[teamId] ? oddsMap[teamId] : 'N/A';
                
                // --- RECORD EXTRACTION ---
                let teamRecord = '';
                const records = comp.team?.records;
                const debugRecordUrl = comp.debugRecordUrl || 'N/A'; 

                if (Array.isArray(records)) {
                    // Find the overall record summary (type 'total')
                    const overallRecord = records.find(r => r.type === 'total' || r.name?.toLowerCase() === 'overall');
                    
                    if (overallRecord) {
                        if (overallRecord.summary) {
                            teamRecord = overallRecord.summary;
                        } else if (overallRecord.displayValue) {
                            teamRecord = overallRecord.displayValue;
                        }
                    }
                }
                if (!teamRecord) teamRecord = 'N/A';
                // --- END RECORD EXTRACTION ---
                
                // --- SCORE EXTRACTION ---
                let rawScore = comp.score; 
                let score = null;

                if (typeof rawScore === 'number' || typeof rawScore === 'string') {
                    const numericScore = Number(rawScore);
                    if (!isNaN(numericScore)) {
                        score = numericScore;
                    }
                }
                // --- END SCORE EXTRACTION ---
                
                if (comp.homeAway === 'home') {
                    homeData = { teamName, score, teamLogo, teamRecord, debugRecordUrl, teamOdds, teamNameAbr }; 
                } else if (comp.homeAway === 'away') {
                    awayData = { teamName, score, teamLogo, teamRecord, debugRecordUrl, teamOdds, teamNameAbr }; 
                }
            });

            // Ensure we have both teams
            if (!homeData.teamName || !awayData.teamName) return;

            const homeScoreNum = homeData.score; // Number or null
            const awayScoreNum = awayData.score; // Number or null
            const statusState = event.statusState; // 'pre', 'in', 'post', etc.

            let homeStatus = 'upcoming'; 
            let awayStatus = 'upcoming';
            let finalHomeScore = homeScoreNum !== null ? homeScoreNum : '-';
            let finalAwayScore = awayScoreNum !== null ? awayScoreNum : '-';

            // --- Game Status Determination ---
            if (statusState === 'post') {
                // Game is final
                if (homeScoreNum !== null && awayScoreNum !== null) {
                    if (homeScoreNum > awayScoreNum) {
                        homeStatus = 'winner';
                        awayStatus = 'loser';
                    } else if (awayScoreNum > homeScoreNum) {
                        homeStatus = 'loser';
                        awayStatus = 'winner';
                    } else {
                        homeStatus = 'tie';
                        awayStatus = 'tie';
                    }
                }
                // Scores remain their actual values
            } else if (statusState && statusState !== 'pre') {
                // Game is 'in', 'half', 'delay', etc. -> In Progress
                homeStatus = 'in-progress';
                awayStatus = 'in-progress';
                // Scores remain their actual values, falling back to '-' if scores are unexpectedly null
            } else { 
                // statusState is 'pre' or missing/unrecognized
                homeStatus = 'upcoming';
                awayStatus = 'upcoming';
                finalHomeScore = '-'; // Set to '-' for upcoming games
                finalAwayScore = '-'; // Set to '-' for upcoming games
            }
            // --- End Game Status Determination ---

            
            const gameName = event.name || `${awayData.teamName} at ${homeData.teamName}`;
            // Capture the L4 URLs added in fetchDeepSchedule
            const debugOddsUrl = event.debugOddsUrl || 'N/A';
            const debugStatusUrl = event.debugStatusUrl || 'N/A';

            extractedGames.push({ 
                name: gameName, 
                homeTeam: homeData.teamName, 
                awayTeam: awayData.teamName,
                homeTeamAbr: homeData.teamNameAbr, 
                awayTeamAbr: awayData.teamNameAbr,
                homeLogo: homeData.teamLogo, 
                awayLogo: awayData.teamLogo, 
                homeRecord: homeData.teamRecord || 'N/A', 
                awayRecord: awayData.teamRecord || 'N/A', 
                homeScore: finalHomeScore, // Use determined score
                awayScore: finalAwayScore, // Use determined score
                homeStatus, 
                awayStatus,
                homeOdds: homeData.teamOdds, 
                awayOdds: awayData.teamOdds, 
                homeDebugRecordUrl: homeData.debugRecordUrl, 
                awayDebugRecordUrl: awayData.debugRecordUrl, 
                debugOddsUrl: debugOddsUrl, 
                debugStatusUrl: debugStatusUrl, 
            });
        });

        return extractedGames;
    }, [targetYear]);

    /**
     * ----------------------------------------------------------------------
     * DEEP SCHEDULE FETCH (Universal Robust Fetcher)
     * ----------------------------------------------------------------------
     */
    const fetchDeepSchedule = useCallback(async (url) => {
        console.log(`--- Universal Deep Fetch Attempt for Year ${targetYear} ---`);
        console.log(`Attempting to fetch URL: ${url}`);
        setApiUrlUsed(url); // Log the URL in state

        let retries = 5;
        let delay = 1000;
        
        for (let i = 0; i < retries; i++) {
            try {
                const response = await fetch(url);
                
                if (!response.ok) {
                    throw new Error(`HTTP Error ${response.status}: ${response.statusText}`);
                }
                
                const data = await response.json();
                let events = data.events || data.items || [];
                
                // --- NESTED FETCH LOGIC (Level 2: Get Event Details) ---
                if (events.length > 0 && !events[0]?.competitions) {
                    console.log('Level 2 Fetch: Competition data missing. Initiating nested fetch for full event details.');
                    
                    const detailPromises = events.map(async (event) => {
                        const rawLink = event.$ref; 
                        if (rawLink) {
                            const detailLink = rawLink.replace(/^http:\/\//i, 'https://');
                            try {
                                const detailResponse = await fetch(detailLink);
                                if (detailResponse.ok) { return detailResponse.json(); }
                            } catch (e) {
                                console.error('Level 2 fetch failed for link:', detailLink, e);
                            }
                        }
                        return null;
                    });

                    const detailedEvents = (await Promise.all(detailPromises)).filter(e => e !== null);
                    events = detailedEvents.filter(e => e && e.competitions?.length > 0);
                    console.log(`Level 2 fetch completed. ${events.length} detailed events found.`);
                }

                // --- NESTED FETCH LOGIC (Level 3/4: Get Full Team Details, Records, Scores, and Odds) ---
                if (events.length > 0) {
                    
                    // --- PHASE 1: L3 Team Details Fetch (Ensures ID, Name, Logo, Records object) ---
                    const teamDetailsPromises = events.flatMap(event => 
                        event.competitions[0].competitors.map(comp => {
                            // If Team ID is missing, we must fetch the full team object first.
                            if (comp.team?.$ref && !comp.team?.id) { 
                                const teamLink = comp.team.$ref.replace(/^http:\/\//i, 'https://');
                                
                                const fetchAndPatchTeam = async () => {
                                    try {
                                        const teamResponse = await fetch(teamLink);
                                        if (teamResponse.ok) {
                                            const teamData = await teamResponse.json();
                                            // Merge all team details, including the 'id', 'logos', and 'records' array
                                            comp.team = { ...comp.team, ...teamData }; 
                                        }
                                    } catch (e) { 
                                        console.error('Level 3 team fetch failed:', teamLink, e); 
                                    }
                                    return null; 
                                };
                                
                                return fetchAndPatchTeam(); 
                            }
                            return Promise.resolve(null);
                        })
                    );

                    // Wait for ALL Level 3 Team Detail fetches to complete
                    await Promise.all(teamDetailsPromises); 
                    console.log('Level 3 Team ID/Detail patching complete.');


                    // --- PHASE 2: L4 Record, Score, Odds, and Status Fetch (Guaranteed to have Team ID now) ---
                    const finalPatchPromises = events.flatMap(event => {
                        if (!event.competitions || event.competitions.length === 0) return [];

                        const competition = event.competitions[0];
                        const eventPromises = [];
                        
                        const eventId = event.id;
                        const competitionId = competition.id;

                        // 1. L4 Odds Fetch
                        let oddsRef = competition.odds?.[0]?.$ref;
                        let oddsLink = null;
                        
                        if (oddsRef) {
                            oddsLink = oddsRef.replace(/^http:\/\//i, 'https://');
                        } else if (eventId && competitionId) {
                            oddsLink = `https://sports.core.api.espn.com/v2/sports/football/leagues/nfl/events/${eventId}/competitions/${competitionId}/odds?lang=en&region=us`;
                        }

                        if (oddsLink) {
                            event.debugOddsUrl = oddsLink;

                            const fetchAndPatchOdds = async () => {
                                try {
                                    const oddsResponse = await fetch(oddsLink);
                                    if (oddsResponse.ok) {
                                        const oddsData = await oddsResponse.json();
                                        const newOdds = Array.isArray(oddsData) ? oddsData : (oddsData.items ? oddsData.items : [oddsData]);
                                        competition.odds = newOdds; 
                                    }
                                } catch (e) { 
                                    console.error('Level 4 odds fetch failed:', oddsLink, e); 
                                }
                                return null;
                            };
                            eventPromises.push(fetchAndPatchOdds());
                        } else {
                             event.debugOddsUrl = 'N/A - Missing Event IDs or API Reference';
                        }
                        
                        // 4. L4 Status Fetch (NEW LOGIC)
                        if (eventId && competitionId) {
                            const statusLink = `https://sports.core.api.espn.com/v2/sports/football/leagues/nfl/events/${eventId}/competitions/${competitionId}/status?lang=en&region=us`;

                            event.debugStatusUrl = statusLink; 

                            const fetchAndPatchStatus = async () => {
                                try {
                                    const statusResponse = await fetch(statusLink);
                                    if (statusResponse.ok) {
                                        const statusData = await statusResponse.json();
                                        const state = statusData.type?.state;
                                        if (state) {
                                            // Patch the main event object with the definitive status state ('pre', 'in', 'post')
                                            event.statusState = state; 
                                        }
                                    }
                                } catch (e) {
                                    console.error('Level 4 status fetch failed:', statusLink, e);
                                }
                                return null;
                            };
                            eventPromises.push(fetchAndPatchStatus());
                        } else {
                            event.debugStatusUrl = 'N/A - Missing Event IDs';
                        }


                        // Map over competitors for Record and Score Fetches (Existing L4 logic)
                        const competitorPromises = competition.competitors.map(comp => {
                            const promises = [];
                            const teamId = comp.team?.id;
                            
                            // Initialize debug URL tracker
                            comp.debugRecordUrl = 'N/A';

                            // 2. Targeted Record Summary Fetch (Level 4)
                            if (teamId && targetYear) { 
                                const recordUrl = `https://sports.core.api.espn.com/v2/sports/football/leagues/nfl/seasons/${targetYear}/types/2/teams/${teamId}/record?lang=en&region=us`;
                                comp.debugRecordUrl = recordUrl; // Store the URL for debugging display
                                
                                const fetchAndPatchRecord = async () => {
                                    try {
                                        const recordResponse = await fetch(recordUrl);
                                        if (recordResponse.ok) {
                                            const recordData = await recordResponse.json();
                                            if (!comp.team.records || !Array.isArray(comp.team.records)) {
                                                comp.team.records = [];
                                            }

                                            const recordArray = recordData.items || recordData.records;
                                            if (recordArray && Array.isArray(recordArray)) {
                                                const fetchedOverallRecord = recordArray.find(r => r.type === 'total' || r.name?.toLowerCase() === 'overall');
                                                let overallRecordInCompetitor = comp.team.records.find(r => r.type === 'total');

                                                if (fetchedOverallRecord) {
                                                    if (!overallRecordInCompetitor) {
                                                        overallRecordInCompetitor = { type: 'total' };
                                                        comp.team.records.push(overallRecordInCompetitor);
                                                    }
                                                    
                                                    if (fetchedOverallRecord.displayValue) {
                                                        overallRecordInCompetitor.summary = fetchedOverallRecord.displayValue;
                                                    } else if (fetchedOverallRecord.summary) {
                                                        overallRecordInCompetitor.summary = fetchedOverallRecord.summary;
                                                    }
                                                }
                                            }
                                        }
                                    } catch (e) { 
                                        console.error('Level 4 record fetch failed:', recordUrl, e); 
                                    }
                                    return null;
                                };
                                promises.push(fetchAndPatchRecord());
                            }


                            // 3. Score Fetch (Level 4)
                            if (comp.score?.$ref && typeof comp.score !== 'number' && typeof comp.score !== 'string') {
                                const scoreLink = comp.score.$ref.replace(/^http:\/\//i, 'https://');
                                
                                const fetchAndPatchScore = async () => {
                                    try {
                                        const scoreResponse = await fetch(scoreLink);
                                        if (scoreResponse.ok) {
                                            const scoreData = await scoreResponse.json();
                                            if (scoreData.value !== undefined) {
                                                comp.score = scoreData.value;
                                            }
                                        }
                                    } catch (e) { console.error('Level 4 score fetch failed:', scoreLink, e); }
                                    return null;
                                };
                                promises.push(fetchAndPatchScore());
                            }
                            return promises;
                        });

                        return [...eventPromises, ...competitorPromises.flat()];
                    });

                    // Wait for ALL Level 4 (Record, Score, Odds, Status) fetches to complete
                    await Promise.all(finalPatchPromises.flat()); 
                    console.log('Level 4 Patching (Record/Score/Odds/Status) complete.');
                }
                // --- END NESTED FETCH LOGIC ---

                const games = extractTeams(events);
                return { games, url }; 
                
            } catch (err) {
                if (err.message.includes("HTTP Error") && i < retries - 1) {
                    await new Promise(resolve => setTimeout(resolve, delay));
                    delay *= 2; 
                } else {
                    throw err; 
                }
            }
        }
        throw new Error("Failed to fetch deep schedule data after multiple retries.");
    }, [extractTeams, targetYear]); 

    /**
     * Core fetching logic for main schedule display.
     */
    const initializeFetch = useCallback(async () => {
        setLoading(true);
        setError(null);
        setGames([]); 
        
        if (!requestedUrl) {
            setLoading(false);
            return;
        }

        const isDeepFetch = requestedUrl !== SCOREBOARD_URL;

        try {
            const result = await fetchDeepSchedule(requestedUrl); 
            
            if (isDeepFetch) {
                setHasAttemptedQuery(true); 
            }
            
            if (isDeepFetch && result.games.length === 0) {
                 throw new Error(`The schedule API returned 0 games for the selected Week/Year. Data may not be available yet.`);
            }
            
            setGames(result.games);
            // apiUrlUsed is set in fetchDeepSchedule
            setLoading(false);

        } catch (finalError) {
            console.error(`Fetch failed:`, finalError.message);
            setError(`Failed to retrieve valid game data. Reason: ${finalError.message}`);
            setLoading(false);
        }
    }, [requestedUrl, fetchDeepSchedule]); 

    
    /**
     * Function to fetch data for the Ranking Modal (UPDATED to use selected week/year)
     */
    const fetchEvents = useCallback(async () => {
        setIsLoading(true);
        setNetworkError(null);
        setEvents([]);
        
        const isSpecificWeek = !!(year && week);
        const urlToFetch = rankingUrl; // Uses the dynamic URL based on selection

        try {
            if (isSpecificWeek) {
                // If specific week is requested, use the robust deep fetcher.
                const result = await fetchDeepSchedule(urlToFetch);

                if (result.games.length === 0) {
                    throw new Error("No games found for this specific week/year to rank.");
                }

                // 1. Convert the deep-fetched games array (which already has odds/teams) into the ranking format
                const rankingData = result.games.map(game => {
                    // Convert odds string back to number for ranking calculation if possible
                    const awayOddsNum = parseInt(game.awayOdds?.replace('+', ''), 10);
                    const homeOddsNum = parseInt(game.homeOdds?.replace('+', ''), 10);
                    
                    let expectedWinner = game.homeOdds === 'N/A' && game.awayOdds === 'N/A' ? 'Toss-Up / N/A' : null;
                    let winnerLine = NaN;

                    if (!isNaN(awayOddsNum) && !isNaN(homeOddsNum)) {
                         // Logic copied from transformEvents to determine winner/line
                         if (awayOddsNum < 0 || homeOddsNum < 0) {
                            if (awayOddsNum < homeOddsNum) {
                                expectedWinner = game.awayTeamAbr;
                                winnerLine = awayOddsNum;
                            } else {
                                expectedWinner = game.homeTeamAbr;
                                winnerLine = homeOddsNum;
                            }
                         } else if (awayOddsNum > 0 && homeOddsNum > 0) {
                            if (awayOddsNum < homeOddsNum) {
                                expectedWinner = game.awayTeamAbr;
                                winnerLine = awayOddsNum;
                            } else {
                                expectedWinner = game.homeTeamAbr;
                                winnerLine = homeOddsNum;
                            }
                         }
                    } else if (!expectedWinner) {
                        expectedWinner = 'Toss-Up / N/A';
                    }

                    return {
                        id: `${game.awayTeam}-${game.homeTeam}`, // Create a unique ID
                        awayTeam: game.awayTeamAbr,
                        homeTeam: game.homeTeamAbr,
                        awayOdds: game.awayOdds,
                        homeOdds: game.homeOdds,
                        expectedWinner: expectedWinner,
                        winnerLine: winnerLine,
                        status: game.homeStatus, // Simplified status
                        confidenceRank: null,
                    };
                });
                
                // 2. Rank the newly created ranking data
                const ranked = rankEvents(rankingData.filter(item => item.expectedWinner !== 'Toss-Up / N/A'));
                
                setEvents(ranked);

            } else {
                // If NOT specific week (i.e., live scoreboard), use the simple /site/v2/scoreboard API (faster)
                const response = await fetch(urlToFetch);

                if (!response.ok) {
                    throw new Error(`HTTP error! Status: ${response.status}`);
                }

                const data = await response.json();
                
                // Step 1: Transform using the standard function expecting the scoreboard structure
                const transformed = transformEvents(data);
                
                // Step 2: Rank (Reversed)
                const ranked = rankEvents(transformed);
                
                setEvents(ranked);
            }
            
            setModalOpen(true);

        } catch (error) {
            console.error('Fetch failed:', error.message);
            setNetworkError(`Error fetching rankings: ${error.message}.`);
            setModalOpen(true);
            
        } finally {
            setIsLoading(false);
        }
    }, [year, week, rankingUrl, fetchDeepSchedule]);


    // Manual Trigger: Fetch only runs when queryTrigger state changes
    useEffect(() => {
        // Run on initial load (queryTrigger = 0) and when button is clicked (queryTrigger > 0)
        initializeFetch();
    }, [queryTrigger, initializeFetch]);


    // Handler for the fetch button click
    const handleFetchClick = () => {
        const targetWeek = week;

        if (targetWeek !== null) {
            // Set 'year' state using 'targetYear' to ensure we capture the current selected year
            setYear(targetYear); 
            setHasAttemptedQuery(true);
            setQueryTrigger(prev => prev + 1);
        }
    };

    // Helper to get dynamic Tailwind classes based on win/loss status
    const getTeamClasses = (status) => {
        switch (status) {
            case 'winner':
                return 'bg-green-100 text-green-900 border-2 border-green-400';
            case 'loser':
                return 'bg-red-100 text-red-900 border-2 border-red-400';
            case 'in-progress':
                return 'bg-yellow-100 text-yellow-900 border-2 border-yellow-400';
            default: // tie or upcoming
                return 'bg-gray-100 text-gray-800 border-2 border-gray-300';
        }
    };

    const getScoreClasses = (status) => {
        switch (status) {
            case 'winner':
                return 'text-green-800';
            case 'loser':
                return 'text-red-800';
            case 'in-progress':
                return 'text-yellow-800';
            default: // tie or upcoming
                return 'text-gray-800';
        }
    };

    // Helper to display the status as requested
    const getStatusLabel = (status) => {
        switch (status) {
            case 'winner': return 'Winner (Final)';
            case 'loser': return 'Loser (Final)';
            case 'tie': return 'Tied (Final)';
            case 'in-progress': return 'In Progress';
            default: return 'Upcoming';
        }
    };


        // --- Modal Component (FOR RANKING UI) ---
    const EventModal = () => {
        if (!modalOpen) return null;

        const maxRank = events.length;

        const modalTitle = year && week ? 
            `Picks for ${year} Week ${week}` : 
            "Picks for This Week";

        return (
          <div 
            className="fixed inset-0 bg-gray-900 bg-opacity-75 flex items-center justify-center p-4 z-[60]" // Higher Z-index than fixed button
            onClick={() => setModalOpen(false)} 
          >
            <div 
              className="bg-gray-50 w-full max-w-4xl max-h-[90vh] rounded-2xl shadow-2xl p-6 overflow-y-auto transform transition-all duration-300"
              onClick={(e) => e.stopPropagation()} 
            >
              <h2 className="text-2xl font-extrabold text-gray-800 border-b pb-2 mb-4 flex items-center">
                <Trophy className="w-6 h-6 mr-2 text-green-600" />
                {modalTitle}
              </h2>

              {networkError ? (
                <div className="text-center p-6 bg-red-100 border-l-4 border-red-500 text-red-700 rounded-lg">
                  <p className="font-bold">Data Fetch Failed</p>
                  <p className="text-sm mt-1">{networkError}</p>
                  <p className="text-xs mt-2 italic">Please check your network environment or try a different week/year selection.</p>
                </div>
              ) : events.length > 0 ? (
                <>
                    {/* ----------------------------------------------------- */}
                    {/* TABLE UI (Desktop/Tablet View) */}
                    {/* ----------------------------------------------------- */}
                    <div className="hidden sm:block overflow-x-auto rounded-xl shadow-lg border border-gray-200">
                      <table className="min-w-full divide-y divide-gray-200">
                        {/* Table Headers */}
                        <thead className="bg-indigo-600/95 text-white">
                          <tr>
                            <th className="px-3 py-3 text-center text-xs font-bold uppercase tracking-wider rounded-tl-xl">
                              Away Team (Odds)
                            </th>
                            <th className="px-3 py-3 text-center text-xs font-bold uppercase tracking-wider">
                              Home Team (Odds)
                            </th>
                            <th className="px-3 py-3 text-center text-xs font-bold uppercase tracking-wider">
                              Expected Winner
                            </th>
                            <th className="px-3 py-3 text-center text-xs font-bold uppercase tracking-wider rounded-tr-xl">
                              Confidence Rank
                            </th>
                          </tr>
                        </thead>
                        {/* Table Body (Desktop) */}
                        <tbody className="bg-white divide-y divide-gray-200">
                          {events.map((event) => {
                              const rankClasses = event.confidenceRank === maxRank ? 'bg-green-600 text-white shadow-lg' :
                                event.confidenceRank >= maxRank - 2 ? 'bg-green-100 text-green-700' :
                                'bg-gray-200 text-gray-700';

                              return (
                                <tr key={event.id} className="hover:bg-indigo-50/50 transition duration-150">
                                  <td className="px-3 py-3 whitespace-nowrap text-sm font-medium text-gray-900 text-center">
                                    <span className="font-bold text-base">{event.awayTeam}</span> 
                                    <span className="text-xs ml-1 text-gray-500">({event.awayOdds || 'N/A'})</span>
                                  </td>
                                  <td className="px-3 py-3 whitespace-nowrap text-sm font-medium text-gray-900 text-center">
                                    <span className="font-bold text-base">{event.homeTeam}</span> 
                                    <span className="text-xs ml-1 text-gray-500">({event.homeOdds || 'N/A'})</span>
                                  </td>
                                  <td className="px-3 py-3 whitespace-nowrap text-sm text-center">
                                    <span className={`px-3 py-1 rounded-full text-xs font-bold ${
                                      event.expectedWinner === event.awayTeam 
                                        ? 'bg-red-100 text-red-800' // Highlight Away winner
                                        : event.expectedWinner === event.homeTeam
                                        ? 'bg-indigo-100 text-indigo-800' // Highlight Home winner
                                        : 'bg-gray-100 text-gray-800'
                                    }`}>
                                      {event.expectedWinner}
                                    </span>
                                  </td>
                                  <td className="px-3 py-3 whitespace-nowrap text-sm text-center">
                                      <span className={`px-4 py-1 rounded-full text-sm font-extrabold ${rankClasses}`}>
                                          {event.confidenceRank}
                                      </span>
                                  </td>
                                </tr>
                            );})}
                        </tbody>
                      </table>
                    </div>
                    
                    {/* ----------------------------------------------------- */}
                    {/* CARD UI (Mobile View) */}
                    {/* ----------------------------------------------------- */}
                    <div className="sm:hidden space-y-3">
                        {events.map((event) => {
                            const isAwayWinner = event.expectedWinner === event.awayTeam;
                            const isHomeWinner = event.expectedWinner === event.homeTeam;
                            
                            const rankClasses = event.confidenceRank === maxRank ? 'bg-green-600 text-white shadow-xl' :
                                event.confidenceRank >= maxRank - 2 ? 'bg-green-500 text-white' :
                                'bg-gray-300 text-gray-800';

                            return (
                                <div 
                                    key={event.id} 
                                    className="p-3 bg-white rounded-xl shadow-lg border border-gray-200 flex items-center justify-between transition duration-150"
                                >
                                    {/* Left Side: Matchup and Odds */}
                                    <div className="flex-1 min-w-0 pr-3">
                                        {/* Matchup Line */}
                                        <div className="flex items-center text-sm font-bold text-gray-900 truncate">
                                            <span className={isAwayWinner ? 'text-indigo-700' : 'text-gray-800'}>{event.awayTeam}</span>
                                            <span className="mx-1 font-normal text-gray-500">@</span>
                                            <span className={isHomeWinner ? 'text-indigo-700' : 'text-gray-800'}>{event.homeTeam}</span>
                                            {' '}
                                            <span className="text-gray-800">Winner:</span> 
                                            <span className={`ml-1 font-bold ${isAwayWinner || isHomeWinner ? 'text-indigo-600' : 'text-gray-500'}`}>
                                                {event.expectedWinner}
                                            </span>
                                        </div>
                                        
                                        {/* Winner and Odds */}
                                        <div className="text-xs mt-1 text-gray-600">
                                            
                                            <span className="ml-2">({event.awayOdds} | {event.homeOdds})</span>
                                        </div>
                                    </div>

                                    {/* Right Side: Rank Badge */}
                                    <div className="flex-shrink-0">
                                        <div className={`w-9 h-9 flex items-center justify-center rounded-full font-extrabold text-lg ${rankClasses}`}>
                                            {event.confidenceRank}
                                        </div>
                                    </div>
                                </div>
                            );
                        })}
                    </div>
                </>
              ) : (
                <p className="text-gray-500 text-center py-8">No events were loaded or found with sufficient odds data to rank for the selected period.</p>
              )}

              <div className="mt-6 text-center">
                <button
                  onClick={() => setModalOpen(false)}
                  className="px-6 py-2 bg-indigo-600 text-white font-semibold rounded-full shadow-lg hover:bg-indigo-700 transition duration-150"
                >
                  Close
                </button>
              </div>
            </div>
          </div>
        );
      };
      // --- End Modal Component ---    
    // ... (rest of App is the same) ...

    // Loading for the main schedule fetcher
    if (loading) {
        return (
            <div className="flex items-center justify-center h-screen bg-gray-50 p-4">
                <div className="flex items-center text-indigo-600 font-semibold p-4 rounded-xl shadow-2xl bg-indigo-100 border border-indigo-300">
                    <svg className="animate-spin h-5 w-5 mr-3" viewBox="0 0 24 24">
                        <circle className="opacity-25" cx="12" cy="12" r="10" stroke="currentColor" strokeWidth="4" fill="none"></circle>
                        <path className="opacity-75" fill="currentColor" d="M4 12a8 8 0 018-8V0C5.373 0 0 5.373 0 12h4zm2 5.291A7.962 7.962 0 014 12H0c0 3.042 1.135 5.824 3 7.938l3-2.647z"></path>
                    </svg>
                    Loading NFL Events... (Performing deep, multi-level API calls)
                </div>
            </div>
        );
    }

    // Error for the main schedule fetcher
    if (error) {
        return (
            <div className="p-8 max-w-3xl mx-auto bg-red-50 min-h-screen">
                <h1 className="text-3xl font-bold text-red-700 mb-4">Data Fetch Error</h1>
                <div className="bg-white p-6 rounded-xl shadow-lg border-l-4 border-red-500">
                    <p className="font-medium text-red-600 mb-2">Could not retrieve valid game data.</p>
                    <p className="text-sm text-gray-700">**Reason:** {error}</p>
                    <p className="text-xs mt-4 text-gray-500">
                        URL Used: {apiUrlUsed || 'N/A'}
                    </p>
                </div>
            </div>
        );
    }

    // Determine the title based on which data set is loaded
    let headerTitle;
    if (requestedUrl === SCOREBOARD_URL) {
        headerTitle = `Live/Recent NFL Scoreboard (Year used for records: ${targetYear})`;
    } else {
        headerTitle = `NFL ${year} Season, Week ${week} Games`;
    }
    
    if (games.length === 0 && (requestedUrl !== SCOREBOARD_URL || hasAttemptedQuery)) {
        headerTitle += ` (No Events Found)`;
    }


    // --- MERGED FINAL RETURN ---
    return (
        <div className="min-h-screen bg-gray-100 flex flex-col items-center p-4 md:p-8 font-sans">
            <style>{`
                /* Custom font import for aesthetics */
                @import url('https://fonts.googleapis.com/css2?family=Inter:wght@100..900&display=swap');
                body { font-family: 'Inter', sans-serif; }
            `}</style>

            {/* Main Schedule Fetcher UI Content */}
            <div className="max-w-3xl mx-auto w-full bg-gray-50 min-h-screen">
                <header className="text-center py-6 mb-6 bg-white rounded-xl shadow-lg">
                    <h1 className="text-3xl font-extrabold text-gray-900">NFL Game Schedule Fetcher</h1>
                    <p className="text-gray-500 mt-1 font-medium">{headerTitle}</p>
                </header>
                
                {/* Selection Controls */}
                <div className="mb-6 p-4 bg-white rounded-xl shadow-lg flex flex-col sm:flex-row gap-4 justify-center items-center">
                    <div className="flex items-center space-x-2">
                        <label htmlFor="year-select" className="font-medium text-gray-700">Year:</label>
                        <select
                            id="year-select"
                            // Display currentYear as the default visually, but keep state null if not selected
                            value={year === null ? currentYear : year} 
                            onChange={(e) => setYear(Number(e.target.value))}
                            className="p-2 border border-gray-300 text-gray-700 rounded-lg shadow-sm focus:ring-indigo-500 focus:border-indigo-500"
                        >
                            {/* Generates options for current year and 2 years prior */}
                            {Array.from({ length: 3 }, (_, i) => currentYear - i).map(y => (
                                <option key={y} value={y}>{y}</option>
                            ))}
                        </select>
                    </div>

                    <div className="flex items-center space-x-2">
                        <label htmlFor="week-select" className="font-medium text-gray-700">Week (1-18):</label>
                        <select
                            id="week-select"
                            value={week === null ? '' : week}
                            onChange={(e) => setWeek(Number(e.target.value))}
                            className="p-2 border border-gray-300 text-gray-700 rounded-lg shadow-sm focus:ring-indigo-500 focus:border-indigo-500"
                        >
                            <option value="" disabled>Select Week</option>
                            {/* Generates options for Week 1 through 18 */}
                            {Array.from({ length: 18 }, (_, i) => i + 1).map(w => (
                                <option key={w} value={w}>Week {w}</option>
                            ))}
                        </select>
                    </div>

                    <button
                        onClick={handleFetchClick}
                        disabled={week === null || loading}
                        className={`
                            p-2.5 rounded-lg font-bold text-white transition duration-200 shadow-lg
                            ${week !== null && !loading
                                ? 'bg-indigo-600 hover:bg-indigo-700 focus:outline-none focus:ring-4 focus:ring-indigo-500 focus:ring-opacity-50'
                                : 'bg-gray-400 cursor-not-allowed'
                            }
                        `}
                    >
                        Fetch Specific Week
                    </button>
                </div>
                
                {/* Game List (Original Display) */}
                <div className="bg-white p-6 rounded-xl shadow-lg">
                    <h2 className="text-xl font-bold text-indigo-700 mb-4 border-b pb-2">Extracted Games ({games.length} Events)</h2>
                    
                    {games.length === 0 && !loading && (
                        <div className="text-center p-8 bg-indigo-50 rounded-lg border border-indigo-200">
                            <p className="text-lg font-semibold text-indigo-700">
                                {requestedUrl === SCOREBOARD_URL 
                                    ? "Displaying recent NFL scoreboard data. Select a specific Year and Week (1-18) above to fetch schedule history."
                                    : "The requested API call returned no games. The current NFL season data may not be available for the specific Week/Year chosen, or the data structure may have changed."
                                }
                            </p>
                        </div>
                    )}
                    
                    {games.length > 0 && (
                        <ul className="space-y-4">
                            {games.map((game, index) => {
                                const awayClasses = getTeamClasses(game.awayStatus);
                                const homeClasses = getTeamClasses(game.homeStatus);

                                // Fallback logo URL for error handling
                                const fallbackLogo = (teamName) => `https://placehold.co/28x28/9ca3af/ffffff?text=${teamName.substring(0, 1)}`;


                                return (
                                    <li 
                                        key={index} 
                                        className="p-4 bg-white border border-gray-200 rounded-xl shadow-sm hover:shadow-md transition duration-150 ease-in-out"
                                    >
                                        <div className="text-sm font-semibold text-gray-700 mb-3 border-b pb-2">
                                            Game {index + 1}: {game.name}
                                        </div>
                                        <div className="grid grid-cols-2 gap-3 text-sm">
                                            
                                            {/* Away Team Block */}
                                            <div className={`p-3 rounded-xl flex flex-col space-y-1 shadow-inner transition duration-150 relative ${awayClasses}`}>
                                                
                                                {/* Team Status (Stays at top) */}
                                                <span className="font-semibold uppercase tracking-wider text-xs text-gray-600">
                                                    {getStatusLabel(game.awayStatus)}
                                                </span>

                                                {/* MAIN CONTENT LINE: Logo | Name (Desktop) / Record (Mobile) | Score */}
                                                <div className="flex items-center justify-between mt-1">
                                                    {/* Left Group: Logo + Name/Record */}
                                                    <div className="flex items-center space-x-2">
                                                        {game.awayLogo && (
                                                            <img 
                                                                src={game.awayLogo} 
                                                                alt={`${game.awayTeam} Logo`} 
                                                                className="w-10 h-10 sm:w-7 sm:h-7 object-contain"
                                                                onError={(e) => { e.target.onerror = null; e.target.src = fallbackLogo(game.awayTeam); }}
                                                            />
                                                        )}
                                                        <div className="flex flex-col">
                                                            {/* Full Name on Desktop, Hidden on Mobile */}
                                                            <span className="hidden sm:inline text-lg font-bold">{game.awayTeam}</span>
                                                            {/* Inline content for mobile: Name (Abr) + Record + Score */}
                                                            <span className="inline sm:hidden text-xs font-bold text-gray-700">
                                                                ({game.awayRecord})
                                                            </span>
                                                        </div>
                                                    </div>

                                                    {/* Right Group: Score */}
                                                    <span className={`text-3xl font-extrabold ${getScoreClasses(game.awayStatus)}`}>
                                                        {game.awayScore}
                                                    </span>
                                                </div>
                                                
                                                {/* Record on Desktop Only */}
                                                <span className="hidden sm:block text-xs font-medium text-gray-700 mt-0.5">
                                                    {game.awayRecord}
                                                </span>


                                                {/* NEW ODDS BOX (Bottom position - Visible on Mobile, Hidden on Desktop) */}
                                                <div className="sm:hidden flex bottom-0 right-0 p-1 px-2 bg-indigo-600 text-white text-xs font-bold rounded-lg shadow-md flex items-center space-x-1">
                                                    /*<div className="flex bottom-0 right-0 p-1 px-2 bg-indigo-600 text-white text-xs font-bold rounded-lg shadow-md flex items-center space-x-1">*/
                                                        <span className="uppercase font-extrabold px-1 bg-white text-indigo-600 rounded-sm">AWAY</span>
                                                        <span className="opacity-80">ML:</span> 
                                                        <span>{game.awayOdds || 'N/A'}</span>
                                                    /*</div>*/
                                                </div>

                                                {/* OLD ODDS BOX (Desktop position - Hidden on Mobile, Visible on Desktop) */}
                                                <div className="hidden sm:flex absolute top-0 right-0 p-1 bg-indigo-600 text-white text-xs font-bold rounded-tr-xl rounded-bl-lg shadow-md items-center space-x-1">
                                                    <span className="uppercase font-extrabold px-1 bg-white text-indigo-600 rounded-sm">AWAY</span>
                                                    <span className="opacity-80">ML:</span> 
                                                    <span>{game.awayOdds || 'N/A'}</span>
                                                </div>
                                            </div>
                                            
                                            {/* Home Team Block */}
                                            <div className={`p-3 rounded-xl flex flex-col space-y-1 shadow-inner transition duration-150 relative ${homeClasses}`}>
                                                
                                                {/* Team Status (Stays at top) */}
                                                <span className="font-semibold uppercase tracking-wider text-xs text-gray-600">
                                                    {getStatusLabel(game.homeStatus)}
                                                </span>
                                                
                                                {/* MAIN CONTENT LINE: Logo | Name (Desktop) / Record (Mobile) | Score */}
                                                <div className="flex items-center justify-between mt-1">
                                                    {/* Left Group: Logo + Name/Record */}
                                                    <div className="flex items-center space-x-2">
                                                        {game.homeLogo && (
                                                            <img 
                                                                src={game.homeLogo} 
                                                                alt={`${game.homeTeam} Logo`} 
                                                                className="w-10 h-10 sm:w-7 sm:h-7 object-contain"
                                                                onError={(e) => { e.target.onerror = null; e.target.src = fallbackLogo(game.homeTeam); }}
                                                            />
                                                        )}
                                                        <div className="flex flex-col">
                                                            {/* Full Name on Desktop, Hidden on Mobile */}
                                                            <span className="hidden sm:inline text-lg font-bold">{game.homeTeam}</span>
                                                            {/* Inline content for mobile: Name (Abr) + Record + Score */}
                                                            <span className="inline sm:hidden text-xs font-bold text-gray-700">
                                                                ({game.homeRecord})
                                                            </span>
                                                        </div>
                                                    </div>

                                                    {/* Right Group: Score */}
                                                    <span className={`text-3xl font-extrabold ${getScoreClasses(game.homeStatus)}`}>
                                                        {game.homeScore}
                                                    </span>
                                                </div>

                                                {/* Record on Desktop Only */}
                                                <span className="hidden sm:block text-xs font-medium text-gray-700 mt-0.5">
                                                    {game.homeRecord}
                                                </span>


                                                {/* NEW ODDS BOX (Bottom position - Visible on Mobile, Hidden on Desktop) */}
                                                <div className="sm:hidden flex">
                                                    <div className="flex bottom-0 right-0 p-1 px-2 bg-indigo-600 text-white text-xs font-bold rounded-lg shadow-md flex items-center space-x-1">
                                                        <span className="uppercase font-extrabold px-1 bg-white text-indigo-600 rounded-sm">HOME</span>
                                                        <span className="opacity-80">ML:</span> 
                                                        <span>{game.homeOdds || 'N/A'}</span>
                                                    </div>
                                                </div>

                                                {/* OLD ODDS BOX (Desktop position - Hidden on Mobile, Visible on Desktop) */}
                                                <div className="hidden sm:flex absolute top-0 right-0 p-1 bg-indigo-600 text-white text-xs font-bold rounded-tr-xl rounded-bl-lg shadow-md items-center space-x-1">
                                                    <span className="uppercase font-extrabold px-1 bg-white text-indigo-600 rounded-sm">HOME</span>
                                                    <span className="opacity-80">ML:</span> 
                                                    <span>{game.homeOdds || 'N/A'}</span>
                                                </div>
                                            </div>
                                        </div>
                                        
                                        {/* DEBUG SECTION */}
                                        {showDebug && (
                                            <div className="mt-4 p-3 bg-gray-50 border border-gray-200 rounded-lg">
                                                <h3 className="font-bold text-xs text-gray-600 mb-2 border-b pb-1">API Debug Endpoints Used ({targetYear})</h3>
                                                
                                                {/* *** L4 Odds Fetch URL is displayed here (constructed or from $ref) *** */}
                                                <p className="text-xs text-gray-700 break-words mb-2">
                                                    <span className="font-semibold text-indigo-500">Odds Fetch URL (L4):</span> {game.debugOddsUrl}
                                                </p>
                                                
                                                <p className="text-xs text-gray-700 break-words mb-2">
                                                    <span className="font-semibold text-green-500">Status Fetch URL (L4):</span> {game.debugStatusUrl}
                                                </p>
                                                
                                                <p className="text-xs text-gray-700 break-words mb-1">
                                                    <span className="font-semibold text-red-500">Away Record URL:</span> {game.awayDebugRecordUrl}
                                                </p>
                                                <p className="text-xs text-gray-700 break-words">
                                                    <span className="font-semibold text-blue-500">Home Record URL:</span> {game.homeDebugRecordUrl}
                                                </p>
                                            </div>
                                        )}
                                    </li>
                                );
                            })}
                        </ul>
                    )}
                </div>
                
                {/* Debug Toggle */}
                <div className="mt-8 flex justify-center">
                    <button 
                        onClick={() => setShowDebug(prev => !prev)}
                        className="text-xs font-light text-gray-500 hover:text-gray-700 transition duration-150 flex items-center p-1 rounded-md"
                    >
                        {showDebug ? 'Hide' : 'Show'} API Debug Info
                        <svg xmlns="http://www.w3.org/2000/svg" className={`h-3 w-3 ml-1 transform transition-transform ${showDebug ? 'rotate-180' : ''}`} viewBox="0 0 20 20" fill="currentColor">
                            <path fillRule="evenodd" d="M5.293 7.293a1 1 0 011.414 0L10 10.586l3.293-3.293a1 1 0 111.414 1.414l-4 4a1 1 0 01-1.414 0l-4-4a1 1 0 010-1.414z" clipRule="evenodd" />
                        </svg>
                    </button>
                </div>
            </div>
          
            {/* Floating Action Button (FAB) (Fixed Bottom Left) */}
            <button
                onClick={fetchEvents}
                disabled={isLoading}
                title={year && week ? `Load Confidence Rankings for ${year} Week ${week}` : "Load Live Confidence Rankings"}
                className={`fixed bottom-4 left-4 w-16 h-16 flex items-center justify-center 
                  rounded-full shadow-2xl z-50 transition duration-150 transform 
                  hover:scale-[1.05] active:scale-95 border-4 border-white
                  ${isLoading ? 'bg-indigo-400 cursor-not-allowed' : 'bg-indigo-600 hover:bg-indigo-700'}`}
              >
                {isLoading ? (
                  // Spinner
                  <svg className="animate-spin h-7 w-7 text-white" xmlns="http://www.w3.org/2000/svg" fill="none" viewBox="0 0 24 24">
                    <circle className="opacity-25" cx="12" cy="12" r="10" stroke="currentColor" strokeWidth="4"></circle>
                    <path className="opacity-75" fill="currentColor" d="M4 12a8 8 0 018-8V0C5.373 0 0 5.373 0 12h4zm2 5.291A7.962 7.962 0 014 12H0c0 3.042 1.135 5.824 3 7.938l3-2.647z"></path>
                  </svg>
                ) : (
                  // Icon
                  <Cpu className="w-7 h-7 text-white" />
                )}
              </button>
            
            <EventModal />
        </div>
    );
};

export default App;
