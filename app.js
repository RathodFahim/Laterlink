import React, { useState, useEffect, useCallback } from 'react';
import { initializeApp } from 'firebase/app';
import {
    getAuth,
    signInAnonymously,
    signInWithCustomToken,
    onAuthStateChanged,
    setPersistence,
    browserLocalPersistence
} from 'firebase/auth';
import {
    getFirestore,
    collection,
    addDoc,
    query,
    onSnapshot,
    deleteDoc,
    doc,
    serverTimestamp,
    orderBy,
    updateDoc // Added updateDoc
} from 'firebase/firestore';

// --- Tailwind CSS (assumed to be available globally) ---

// --- Helper to get Firebase config and App ID ---
const getFirebaseConfig = () => {
    if (typeof __firebase_config !== 'undefined') {
        try {
            return JSON.parse(__firebase_config);
        } catch (e) {
            console.error("Error parsing __firebase_config:", e);
            return null;
        }
    }
    return null;
};

const appId = typeof __app_id !== 'undefined' ? __app_id : 'default-laterlink-app';

// --- YouTube Video ID Extractor ---
const getYouTubeVideoId = (url) => {
    if (!url) return null;
    const regExp = /^.*(youtu.be\/|v\/|u\/\w\/|embed\/|watch\?v=|&v=)([^#&?]*).*/;
    const match = url.match(regExp);
    return (match && match[2].length === 11) ? match[2] : null;
};

// --- Main App Component ---
function App() {
    const [db, setDb] = useState(null);
    const [auth, setAuth] = useState(null);
    const [userId, setUserId] = useState(null);
    const [isAuthReady, setIsAuthReady] = useState(false);

    const [links, setLinks] = useState([]);
    const [newLinkUrl, setNewLinkUrl] = useState('');
    const [newLinkTitle, setNewLinkTitle] = useState('');
    const [isLoading, setIsLoading] = useState(true); // General loading for links
    const [error, setError] = useState('');
    const [showAddForm, setShowAddForm] = useState(false);

    // State for Gemini API feature
    const [summaries, setSummaries] = useState({}); // Store summaries by link ID
    const [isSummarizing, setIsSummarizing] = useState({}); // Loading state per link ID

    // Initialize Firebase and Auth
    useEffect(() => {
        const firebaseConfig = getFirebaseConfig();
        if (firebaseConfig) {
            try {
                const app = initializeApp(firebaseConfig);
                const firestoreDb = getFirestore(app);
                const firebaseAuth = getAuth(app);
                
                setDb(firestoreDb);
                setAuth(firebaseAuth);

                setPersistence(firebaseAuth, browserLocalPersistence)
                    .then(() => {
                        const unsubscribe = onAuthStateChanged(firebaseAuth, async (user) => {
                            if (user) {
                                setUserId(user.uid);
                                console.log("User is signed in with UID:", user.uid);
                            } else {
                                console.log("User is signed out. Attempting to sign in...");
                                try {
                                    if (typeof __initial_auth_token !== 'undefined' && __initial_auth_token) {
                                        await signInWithCustomToken(firebaseAuth, __initial_auth_token);
                                    } else {
                                        await signInAnonymously(firebaseAuth);
                                    }
                                } catch (authError) {
                                    console.error("Error during sign-in:", authError);
                                    setError("Authentication failed. Please try again later.");
                                }
                            }
                            setIsAuthReady(true);
                        });
                        return unsubscribe;
                    })
                    .catch((persistenceError) => {
                        console.error("Error setting auth persistence:", persistenceError);
                        setError("Could not initialize session. Please try again.");
                        setIsAuthReady(true);
                    });

            } catch (e) {
                console.error("Firebase initialization error:", e);
                setError("Could not initialize the application. Please check the console.");
                setIsLoading(false);
                setIsAuthReady(true);
            }
        } else {
            console.error("Firebase config is not available.");
            setError("Application configuration is missing. Cannot start.");
            setIsLoading(false);
            setIsAuthReady(true);
        }
    }, []);

    // Fetch links from Firestore
    useEffect(() => {
        if (isAuthReady && db && userId) {
            setIsLoading(true);
            const linksCollectionPath = `artifacts/${appId}/users/${userId}/laterTubeLinks`;
            const linksCollectionRef = collection(db, linksCollectionPath); // Corrected variable name
            const q = query(linksCollectionRef, orderBy("addedAt", "desc"));

            const unsubscribe = onSnapshot(q, (snapshot) => {
                const fetchedLinks = snapshot.docs.map(doc => ({
                    id: doc.id,
                    ...doc.data()
                }));
                setLinks(fetchedLinks);
                // Initialize summaries state for fetched links that have a summary
                const initialSummaries = {};
                fetchedLinks.forEach(link => {
                    if (link.summary) {
                        initialSummaries[link.id] = link.summary;
                    }
                });
                setSummaries(prev => ({...prev, ...initialSummaries}));
                setIsLoading(false);
                setError('');
            }, (err) => {
                console.error("Error fetching links:", err);
                setError("Failed to load links. Please check your connection or try again later.");
                setIsLoading(false);
            });

            return () => unsubscribe();
        } else if (isAuthReady && !userId) {
            setIsLoading(false);
        }
    }, [db, userId, isAuthReady, appId]);


    const handleAddLink = async (e) => {
        e.preventDefault();
        if (!newLinkUrl.trim() || !newLinkTitle.trim()) {
            setError("Both URL and Title are required.");
            return;
        }
        if (!db || !userId) {
            setError("Database not ready or user not authenticated.");
            return;
        }

        const videoId = getYouTubeVideoId(newLinkUrl);
        if (!videoId) {
            setError("Invalid YouTube URL. Please enter a valid YouTube video link.");
            return;
        }

        setError('');
        // setIsLoading(true); // This isLoading is for the overall list, not individual actions
        const linksCollectionPath = `artifacts/${appId}/users/${userId}/laterTubeLinks`;

        try {
            await addDoc(collection(db, linksCollectionPath), {
                url: newLinkUrl,
                title: newLinkTitle,
                videoId: videoId,
                addedAt: serverTimestamp(),
                userId: userId,
                summary: null, // Initialize summary field
            });
            setNewLinkUrl('');
            setNewLinkTitle('');
            setShowAddForm(false);
        } catch (err) {
            console.error("Error adding link:", err);
            setError("Failed to add link. Please try again.");
        }
        // finally { setIsLoading(false); }
    };

    const handleDeleteLink = async (linkId) => {
        if (!db || !userId) {
            setError("Database not ready or user not authenticated.");
            return;
        }
        setError('');
        // setIsLoading(true);
        const linkDocPath = `artifacts/${appId}/users/${userId}/laterTubeLinks/${linkId}`;
        try {
            await deleteDoc(doc(db, linkDocPath));
            setSummaries(prev => { // Remove summary if link is deleted
                const newSummaries = {...prev};
                delete newSummaries[linkId];
                return newSummaries;
            });
        } catch (err) {
            console.error("Error deleting link:", err);
            setError("Failed to delete link. Please try again.");
        }
        // finally { setIsLoading(false); }
    };

    // --- Gemini API Function ---
    const handleGetSummary = async (linkId, linkTitle, linkUrl) => {
        if (!db || !userId) {
            setError("Database not ready or user not authenticated for summary.");
            return;
        }
        setIsSummarizing(prev => ({ ...prev, [linkId]: true }));
        setSummaries(prev => ({ ...prev, [linkId]: "✨ Generating summary..."})); // Clear previous summary or set loading text

        const prompt = `Based on the title and URL, provide a concise, one to two-sentence speculative summary of what the YouTube video titled "${linkTitle}" (URL: ${linkUrl}) might be about. Focus on the likely main topic or purpose. If you cannot make a reasonable inference, say so.`;

        let chatHistory = [{ role: "user", parts: [{ text: prompt }] }];
        const payload = { contents: chatHistory };
        const apiKey = ""; // For gemini-2.0-flash, API key is handled by the environment
        const apiUrl = `https://generativelanguage.googleapis.com/v1beta/models/gemini-2.0-flash:generateContent?key=${apiKey}`;

        try {
            const response = await fetch(apiUrl, {
                method: 'POST',
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify(payload)
            });

            if (!response.ok) {
                const errorData = await response.json();
                console.error("Gemini API error response:", errorData);
                throw new Error(`API request failed with status ${response.status}: ${errorData?.error?.message || 'Unknown error'}`);
            }

            const result = await response.json();

            if (result.candidates && result.candidates.length > 0 &&
                result.candidates[0].content && result.candidates[0].content.parts &&
                result.candidates[0].content.parts.length > 0) {
                const textSummary = result.candidates[0].content.parts[0].text;
                setSummaries(prev => ({ ...prev, [linkId]: textSummary }));

                // Save summary to Firestore
                const linkDocPath = `artifacts/${appId}/users/${userId}/laterTubeLinks/${linkId}`;
                await updateDoc(doc(db, linkDocPath), { summary: textSummary });

            } else {
                console.error("Unexpected response structure from Gemini API:", result);
                setSummaries(prev => ({ ...prev, [linkId]: "Could not generate summary (unexpected response)." }));
            }
        } catch (err) {
            console.error("Error calling Gemini API:", err);
            setSummaries(prev => ({ ...prev, [linkId]: `Error: ${err.message || "Failed to get summary."}` }));
        } finally {
            setIsSummarizing(prev => ({ ...prev, [linkId]: false }));
        }
    };


    if (!isAuthReady && isLoading) { // Initial app loading (before auth is ready)
        return (
            <div className="min-h-screen bg-slate-900 text-white flex flex-col items-center justify-center p-4 font-inter">
                <div className="text-2xl">Initializing App...</div>
                <svg className="animate-spin h-8 w-8 text-sky-500 mt-4" xmlns="http://www.w3.org/2000/svg" fill="none" viewBox="0 0 24 24">
                    <circle className="opacity-25" cx="12" cy="12" r="10" stroke="currentColor" strokeWidth="4"></circle>
                    <path className="opacity-75" fill="currentColor" d="M4 12a8 8 0 018-8V0C5.373 0 0 5.373 0 12h4zm2 5.291A7.962 7.962 0 014 12H0c0 3.042 1.135 5.824 3 7.938l3-2.647z"></path>
                </svg>
            </div>
        );
    }
    
    return (
        <div className="min-h-screen bg-slate-900 text-white flex flex-col items-center p-4 sm:p-6 md:p-8 font-inter">
            <header className="w-full max-w-4xl mb-8 text-center">
                <h1 className="text-4xl sm:text-5xl font-bold text-sky-400">LaterLink Saver</h1>
                <p className="text-slate-400 mt-2">Save YouTube links and ✨ get quick summaries!</p>
                {userId && <p className="text-xs text-slate-500 mt-1">User ID: {userId}</p>}
            </header>

            {error && (
                <div className="w-full max-w-md bg-red-500/20 border border-red-700 text-red-300 px-4 py-3 rounded-lg relative mb-6" role="alert">
                    <strong className="font-bold">Error: </strong>
                    <span className="block sm:inline">{error}</span>
                </div>
            )}

            {!showAddForm && (
                 <button
                    onClick={() => setShowAddForm(true)}
                    className="mb-8 bg-sky-500 hover:bg-sky-600 text-white font-semibold py-3 px-6 rounded-lg shadow-md hover:shadow-lg transition duration-150 ease-in-out transform hover:scale-105 flex items-center"
                >
                    <svg xmlns="http://www.w3.org/2000/svg" className="h-5 w-5 mr-2" viewBox="0 0 20 20" fill="currentColor">
                        <path fillRule="evenodd" d="M10 3a1 1 0 011 1v5h5a1 1 0 110 2h-5v5a1 1 0 11-2 0v-5H4a1 1 0 110-2h5V4a1 1 0 011-1z" clipRule="evenodd" />
                    </svg>
                    Add New Link
                </button>
            )}

            {showAddForm && (
                <form onSubmit={handleAddLink} className="w-full max-w-md mb-8 p-6 bg-slate-800 rounded-xl shadow-2xl">
                    <div className="mb-5">
                        <label htmlFor="linkUrl" className="block mb-2 text-sm font-medium text-sky-300">YouTube Link URL</label>
                        <input
                            type="url"
                            id="linkUrl"
                            value={newLinkUrl}
                            onChange={(e) => setNewLinkUrl(e.target.value)}
                            placeholder="e.g., https://www.youtube.com/watch?v=dQw4w9WgXcQ"
                            required
                            className="w-full p-3 bg-slate-700 border border-slate-600 rounded-lg text-white placeholder-slate-400 focus:ring-2 focus:ring-sky-500 focus:border-sky-500 outline-none transition duration-150"
                        />
                    </div>
                    <div className="mb-6">
                        <label htmlFor="linkTitle" className="block mb-2 text-sm font-medium text-sky-300">Custom Title</label>
                        <input
                            type="text"
                            id="linkTitle"
                            value={newLinkTitle}
                            onChange={(e) => setNewLinkTitle(e.target.value)}
                            placeholder="e.g., My Awesome Video"
                            required
                            className="w-full p-3 bg-slate-700 border border-slate-600 rounded-lg text-white placeholder-slate-400 focus:ring-2 focus:ring-sky-500 focus:border-sky-500 outline-none transition duration-150"
                        />
                    </div>
                    <div className="flex items-center justify-between gap-4">
                        <button
                            type="submit"
                            disabled={isLoading} // Consider a specific loading state for adding
                            className="w-full bg-green-500 hover:bg-green-600 text-white font-semibold py-3 px-4 rounded-lg shadow-md hover:shadow-lg transition duration-150 ease-in-out disabled:opacity-50 flex items-center justify-center"
                        >
                            {/* Add loading spinner if needed for add operation */}
                            <svg xmlns="http://www.w3.org/2000/svg" className="h-5 w-5 mr-2" viewBox="0 0 20 20" fill="currentColor">
                                <path fillRule="evenodd" d="M10 18a8 8 0 100-16 8 8 0 000 16zm1-11a1 1 0 10-2 0v2H7a1 1 0 100 2h2v2a1 1 0 102 0v-2h2a1 1 0 100-2h-2V7z" clipRule="evenodd" />
                            </svg>
                            Save Link
                        </button>
                         <button
                            type="button"
                            onClick={() => setShowAddForm(false)}
                            className="w-full bg-slate-600 hover:bg-slate-700 text-slate-300 font-semibold py-3 px-4 rounded-lg shadow-md hover:shadow-lg transition duration-150 ease-in-out"
                        >
                            Cancel
                        </button>
                    </div>
                </form>
            )}

            {isLoading && links.length === 0 && !error && isAuthReady && ( // Loading links state
                 <div className="text-center text-slate-400">
                    <svg className="animate-spin h-8 w-8 text-sky-500 mx-auto mb-2" xmlns="http://www.w3.org/2000/svg" fill="none" viewBox="0 0 24 24">
                       <circle className="opacity-25" cx="12" cy="12" r="10" stroke="currentColor" strokeWidth="4"></circle>
                       <path className="opacity-75" fill="currentColor" d="M4 12a8 8 0 018-8V0C5.373 0 0 5.373 0 12h4zm2 5.291A7.962 7.962 0 014 12H0c0 3.042 1.135 5.824 3 7.938l3-2.647z"></path>
                    </svg>
                    Loading links...
                 </div>
            )}

            {!isLoading && links.length === 0 && !error && isAuthReady && (
                <div className="text-center text-slate-500 mt-8 p-6 bg-slate-800 rounded-lg shadow-lg">
                    <svg xmlns="http://www.w3.org/2000/svg" className="h-16 w-16 text-slate-600 mx-auto mb-4" fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth="1">
                        <path strokeLinecap="round" strokeLinejoin="round" d="M9.172 16.172a4 4 0 015.656 0M9 10h.01M15 10h.01M21 12a9 9 0 11-18 0 9 9 0 0118 0z" />
                         <path strokeLinecap="round" strokeLinejoin="round" d="M15.536 14.364A4.002 4.002 0 0112 16.5a4 4 0 01-3.536-2.136m0 0A3.986 3.986 0 018 12.5c0-1.27.594-2.4 1.536-3.136M12 3.5c2.09 0 3.964.967 5.235 2.5M6.765 6A8.965 8.965 0 0112 3.5m0 0V2m0 1.5a8.965 8.965 0 00-5.235 2.5M12 21.5V20m0 1.5a8.965 8.965 0 01-5.235-2.5m10.47 0c1.43-.967 2.485-2.33 2.735-3.864m-2.735 3.864A8.965 8.965 0 0112 21.5" />
                    </svg>
                    <p className="text-xl">No links saved yet.</p>
                    <p>Click "Add New Link" to get started!</p>
                </div>
            )}
            
            {!isAuthReady && !isLoading && ( // Auth problem
                 <div className="text-center text-red-400 mt-8 p-6 bg-red-800/30 rounded-lg shadow-lg">
                    <p className="text-xl">Authentication Problem</p>
                    <p>Could not authenticate. Your links cannot be loaded or saved.</p>
                    <p>Please check your internet connection or try refreshing the page.</p>
                 </div>
            )}


            <div className="w-full max-w-4xl grid grid-cols-1 md:grid-cols-2 lg:grid-cols-3 gap-6 mt-8">
                {links.map(link => (
                    <div key={link.id} className="bg-slate-800 rounded-xl shadow-xl overflow-hidden flex flex-col transition-all duration-300 hover:shadow-sky-500/30 hover:ring-1 hover:ring-sky-600">
                        <div className="aspect-w-16 aspect-h-9">
                            <iframe
                                className="w-full h-full"
                                src={`https://www.youtube.com/embed/${link.videoId}`}
                                title={link.title}
                                frameBorder="0"
                                allow="accelerometer; autoplay; clipboard-write; encrypted-media; gyroscope; picture-in-picture"
                                allowFullScreen
                            ></iframe>
                        </div>
                        <div className="p-5 flex flex-col flex-grow">
                            <h3 className="text-lg font-semibold text-sky-400 mb-2 truncate" title={link.title}>{link.title}</h3>
                            <p className="text-xs text-slate-400 mb-1 truncate" title={link.url}>
                                <a href={link.url} target="_blank" rel="noopener noreferrer" className="hover:text-sky-300 hover:underline">
                                    {link.url}
                                </a>
                            </p>
                            <p className="text-xs text-slate-500 mb-4">
                                Added: {link.addedAt?.toDate ? new Date(link.addedAt.toDate()).toLocaleString() : 'Recently'}
                            </p>

                            {/* Gemini Summary Section */}
                            <div className="mt-3 mb-3 pt-3 border-t border-slate-700">
                                {summaries[link.id] && (
                                    <div className="text-sm text-slate-300 mb-2 prose prose-sm prose-invert max-w-none">
                                        <p className="font-semibold text-sky-400">Summary:</p>
                                        <p>{summaries[link.id]}</p>
                                    </div>
                                )}
                                <button
                                    onClick={() => handleGetSummary(link.id, link.title, link.url)}
                                    disabled={isSummarizing[link.id]}
                                    className="w-full bg-purple-600 hover:bg-purple-700 text-white font-medium py-2 px-3 rounded-md shadow-sm hover:shadow-md transition duration-150 ease-in-out disabled:opacity-60 flex items-center justify-center text-sm"
                                >
                                    {isSummarizing[link.id] ? (
                                        <svg className="animate-spin -ml-1 mr-2 h-4 w-4 text-white" xmlns="http://www.w3.org/2000/svg" fill="none" viewBox="0 0 24 24">
                                            <circle className="opacity-25" cx="12" cy="12" r="10" stroke="currentColor" strokeWidth="4"></circle>
                                            <path className="opacity-75" fill="currentColor" d="M4 12a8 8 0 018-8V0C5.373 0 0 5.373 0 12h4zm2 5.291A7.962 7.962 0 014 12H0c0 3.042 1.135 5.824 3 7.938l3-2.647z"></path>
                                        </svg>
                                    ) : (
                                      '✨'
                                    )}
                                    {isSummarizing[link.id] ? 'Getting Summary...' : summaries[link.id] && summaries[link.id] !== "✨ Generating summary..." && !summaries[link.id].startsWith("Error:") ? 'Regenerate Summary' : 'Get Summary'}
                                </button>
                            </div>
                            
                            <div className="mt-auto">
                                <button
                                    onClick={() => handleDeleteLink(link.id)}
                                    disabled={isLoading || isSummarizing[link.id]} // Disable if general loading or summarizing this link
                                    className="w-full bg-red-600 hover:bg-red-700 text-white font-medium py-2 px-3 rounded-md shadow-sm hover:shadow-md transition duration-150 ease-in-out disabled:opacity-60 flex items-center justify-center text-sm"
                                >
                                    <svg xmlns="http://www.w3.org/2000/svg" className="h-4 w-4 mr-2" viewBox="0 0 20 20" fill="currentColor">
                                        <path fillRule="evenodd" d="M9 2a1 1 0 00-.894.553L7.382 4H4a1 1 0 000 2v10a2 2 0 002 2h8a2 2 0 002-2V6a1 1 0 100-2h-3.382l-.724-1.447A1 1 0 0011 2H9zM7 8a1 1 0 012 0v6a1 1 0 11-2 0V8zm5-1a1 1 0 00-1 1v6a1 1 0 102 0V8a1 1 0 00-1-1z" clipRule="evenodd" />
                                    </svg>
                                    Delete
                                </button>
                            </div>
                        </div>
                    </div>
                ))}
            </div>
        </div>
    );
}

export default App;
