const ytSearch = require('youtube-search-api');
console.log("Searching for 'kudda'...");
ytSearch.GetListByKeyword('kudda', false, 1).then(result => {
    console.log("Search Result:", JSON.stringify(result, null, 2));
    process.exit(0);
}).catch(err => {
    console.error("Search Error:", err);
    process.exit(1);
});
