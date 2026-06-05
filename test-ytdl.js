const ytdl = require('@distube/ytdl-core');
const fs = require('fs');
const path = require('path');

const url = 'https://www.youtube.com/watch?v=dQw4w9WgXcQ'; // Rick Astley - Never Gonna Give You Up

console.log('Fetching video info...');
ytdl.getInfo(url).then(info => {
    console.log('Title:', info.videoDetails.title);
    
    console.log('Downloading audio...');
    const audioStream = ytdl(url, { filter: 'audioonly', quality: 'highestaudio' });
    const outputAudio = path.join(__dirname, 'test_audio.mp3');
    const writeAudio = fs.createWriteStream(outputAudio);
    
    audioStream.pipe(writeAudio);
    writeAudio.on('finish', () => {
        console.log('Audio download finished:', outputAudio);
        console.log('File size:', fs.statSync(outputAudio).size, 'bytes');
        
        // clean up
        fs.unlinkSync(outputAudio);
        process.exit(0);
    });
    
    writeAudio.on('error', err => {
        console.error('Write audio error:', err);
        process.exit(1);
    });
    audioStream.on('error', err => {
        console.error('Audio stream error:', err);
        process.exit(1);
    });
}).catch(err => {
    console.error('Info fetch error:', err);
    process.exit(1);
});
