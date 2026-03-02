const express = require('express');
const http = require('http');
const { Server } = require('socket.io');
const cors = require('cors');
const mongoose = require('mongoose');

const app = express();
const PORT = process.env.PORT || 3000;

// 1. 미들웨어 설정
app.use(cors());
app.use(express.json());

// 2. MongoDB 연결 설정
mongoose.connect(process.env.MONGODB_URI || 'mongodb+srv://kmy12083:c7elYelcnPQnpSVH@omok14.gz1uewk.mongodb.net/?')
    .then(() => console.log("[DB] MongoDB 연결 성공"))
    .catch(err => console.error("[DB] MongoDB 연결 실패:", err));

// 3. 유저 데이터 스키마 정의
const userSchema = new mongoose.Schema({
    email:     { type: String, required: true, unique: true },
    password:  { type: String, required: true },
    elo:       { type: Number, default: 1200 },   // ELO 레이팅 (초기값 1200)
    createdAt: { type: Date, default: Date.now }
});
const User = mongoose.model('User', userSchema);

// 4. HTTP 서버 및 Socket.io 설정
const server = http.createServer(app);
const io = new Server(server, {
    cors: { origin: "*", methods: ["GET", "POST"] }
});

// [수정] 매칭 대기열을 모든 커넥션이 공유하도록 모듈 레벨로 이동
let waitingPlayer = null;

// 소켓별 게임 정보 추적 (돌 중계용): socketId -> { roomId, playerNum }
const playerRooms = {};

// 방별 리셋 투표 수 추적: roomId -> vote count
const roomResetVotes = {};

// 방별 ELO 결과 처리 여부 추적 (중복 처리 방지): roomId -> boolean
const roomResultReported = {};

// ELO 계산 (K=32, 표준 공식)
function calculateElo(winnerElo, loserElo) {
    const K = 32;
    const expectedWin = 1 / (1 + Math.pow(10, (loserElo - winnerElo) / 400));
    return {
        winnerNew: Math.round(winnerElo + K * (1 - expectedWin)),
        loserNew:  Math.round(loserElo  + K * (0 - (1 - expectedWin)))
    };
}

// 5. 소켓 이벤트 처리
io.on('connection', (socket) => {
    console.log(`[알림] 새 클라이언트 접속! (ID: ${socket.id})`);

    // --- 회원가입 요청 처리 ---
    socket.on('register', async (data) => {
        const { email, password } = data;
        console.log("================================");
        console.log(`[회원가입 요청 받음] ID: ${socket.id}`);
        console.log(`이메일: ${email}`);
        console.log("================================");

        if (!email || !password) {
            return socket.emit('registerResponse', {
                success: false, code: 2, message: "이메일/비밀번호 형식 오류"
            });
        }
        try {
            const existingUser = await User.findOne({ email });
            if (existingUser) {
                return socket.emit('registerResponse', {
                    success: false, code: 1, message: "이미 생성된 계정"
                });
            }
            const newUser = new User({ email, password });
            await newUser.save();
            socket.emit('registerResponse', { success: true, code: 0, message: "회원가입 완료" });
            console.log(`[DB] 새 유저 등록 성공: ${email}`);
        } catch (error) {
            console.error("[DB 에러]", error);
            socket.emit('registerResponse', {
                success: false, code: 99, message: "서버 내부 에러 발생"
            });
        }
    });

    // --- 로그인 요청 처리 ---
    socket.on('login', async (data) => {
        const { email, password } = data;
        try {
            const user = await User.findOne({ email });
            if (!user) return socket.emit('loginResponse', { success: false, code: 1, message: "계정없음" });
            if (user.password === password) return socket.emit('loginResponse', { success: true, code: 0, message: "성공" });
            else return socket.emit('loginResponse', { success: false, code: 2, message: "비번틀림" });
        } catch (e) {
            socket.emit('loginResponse', { success: false, code: 99, message: "에러" });
        }
    });

    // --- 매칭 요청 처리 ---
    socket.on('requestMatchmaking', (data) => {
        console.log(`매칭 요청: ${data.email}`);

        if (waitingPlayer === null) {
            // 대기자가 없으면 본인이 대기
            waitingPlayer = { socket, email: data.email };
            socket.emit('waiting', { message: '상대를 찾는 중입니다...' });
        } else {
            // 대기자가 있으면 방 생성 후 매칭
            const roomId = `room_${Date.now()}`;
            const opponent = waitingPlayer;
            waitingPlayer = null;

            socket.join(roomId);
            opponent.socket.join(roomId);

            // [수정] 무작위로 선공(흑돌) 결정
            const startingPlayer = Math.random() < 0.5 ? 1 : 2;

            // 소켓별 방/플레이어 번호 + 이메일 기록 (돌 중계 및 ELO 업데이트용)
            playerRooms[socket.id]          = { roomId, playerNum: 2, email: data.email };
            playerRooms[opponent.socket.id] = { roomId, playerNum: 1, email: opponent.email };

            // 리셋 투표 및 ELO 결과 초기화
            roomResetVotes[roomId]     = 0;
            roomResultReported[roomId] = false;

            console.log(`[매칭] 방 생성: ${roomId} | 선공: Player ${startingPlayer}`);

            // [수정] 클라이언트가 기대하는 필드(myPlayerNumber, isMyTurn, startingPlayer)로 전송
            opponent.socket.emit('matchFound', {
                roomId,
                myPlayerNumber: 1,
                isMyTurn:       startingPlayer === 1,
                startingPlayer
            });
            socket.emit('matchFound', {
                roomId,
                myPlayerNumber: 2,
                isMyTurn:       startingPlayer === 2,
                startingPlayer
            });
        }
    });

    // --- 매칭 취소 ---
    socket.on('cancelMatchmaking', () => {
        // waitingPlayer 대기열에 있는 경우에만 취소 가능
        // (이미 matchFound가 전송된 뒤라면 playerRooms에 등록돼 있으므로 여기에 해당 없음)
        if (waitingPlayer && waitingPlayer.socket.id === socket.id) {
            waitingPlayer = null;
            console.log(`[매칭 취소] ${socket.id} 대기열 제거됨`);
        }
    });

    // --- 돌 놓기 중계 ---
    socket.on('placeStone', (data) => {
        const info = playerRooms[socket.id];
        if (!info) return;

        console.log(`[돌] Player ${info.playerNum} → (${data.row}, ${data.col}) in ${info.roomId}`);

        // 같은 방의 모든 플레이어에게 전달 (본인 포함 — 본인 화면에도 돌을 그려야 하므로)
        // playerATime / playerBTime 은 착수 시점의 타이머 스냅샷이며, 상대방 동기화에 사용됨
        io.to(info.roomId).emit('stonePlaced', {
            row:         data.row,
            col:         data.col,
            player:      info.playerNum,
            playerATime: data.playerATime,
            playerBTime: data.playerBTime
        });
    });

    // --- 게임 리셋 투표 ---
    socket.on('requestReset', () => {
        const info = playerRooms[socket.id];
        if (!info) return;
        const { roomId } = info;

        roomResetVotes[roomId] = (roomResetVotes[roomId] || 0) + 1;
        console.log(`[리셋 투표] ${roomId}: ${roomResetVotes[roomId]}/2`);

        if (roomResetVotes[roomId] >= 2) {
            roomResetVotes[roomId] = 0;
            const newStartingPlayer = Math.random() < 0.5 ? 1 : 2;
            console.log(`[리셋 확정] ${roomId}: 선공 Player ${newStartingPlayer}`);
            io.to(roomId).emit('resetConfirmed', { startingPlayer: newStartingPlayer });
        }
    });

    // --- 게임 나가기 (상대방에게 강제 퇴장 알림) ---
    socket.on('exitGame', () => {
        const info = playerRooms[socket.id];
        if (!info) return;
        const { roomId } = info;

        console.log(`[나가기] Player ${info.playerNum}이(가) ${roomId}에서 나갑니다.`);
        // 상대방에게만 알림 (나가는 플레이어는 클라이언트에서 직접 씬 전환)
        socket.to(roomId).emit('forceExit');
        delete roomResetVotes[roomId];
    });

    // --- 승리 보고 → ELO 업데이트 ---
    // 승리한 클라이언트가 전송. roomResultReported로 중복 처리 방지.
    socket.on('reportWin', async () => {
        const info = playerRooms[socket.id];
        if (!info) return;
        const { roomId } = info;

        if (roomResultReported[roomId]) {
            console.log(`[ELO] ${roomId}: 이미 결과 처리됨, 무시`);
            return;
        }
        roomResultReported[roomId] = true;

        const winnerEmail = info.email;
        // 같은 방의 다른 플레이어 = 패자
        const loserEntry = Object.values(playerRooms).find(
            p => p.roomId === roomId && p.email !== winnerEmail
        );
        if (!loserEntry) {
            console.log('[ELO] 패자 정보를 찾을 수 없음 (이미 나간 플레이어)');
            return;
        }

        try {
            const winner = await User.findOne({ email: winnerEmail });
            const loser  = await User.findOne({ email: loserEntry.email });
            if (!winner || !loser) return;

            const prevWinnerElo = winner.elo;
            const prevLoserElo  = loser.elo;
            const { winnerNew, loserNew } = calculateElo(prevWinnerElo, prevLoserElo);

            winner.elo = winnerNew;
            loser.elo  = Math.max(0, loserNew); // ELO는 0 미만으로 내려가지 않음
            await winner.save();
            await loser.save();

            console.log(`[ELO] 승: ${winnerEmail} ${prevWinnerElo} → ${winnerNew}`);
            console.log(`[ELO] 패: ${loserEntry.email} ${prevLoserElo} → ${loser.elo}`);
        } catch (err) {
            console.error('[ELO] 업데이트 에러:', err);
        }
    });

    // --- 랭킹 조회 ---
    socket.on('getLeaderboard', async () => {
        try {
            const users = await User
                .find({}, { email: 1, elo: 1, _id: 0 })
                .sort({ elo: -1 })
                .limit(50);
            socket.emit('leaderboardData', users);
            console.log(`[랭킹] ${users.length}명 조회 완료`);
        } catch (err) {
            console.error('[랭킹] 조회 에러:', err);
        }
    });

    // --- 연결 종료 ---
    socket.on('disconnect', () => {
        console.log(`[알림] 클라이언트 접속 종료 (ID: ${socket.id})`);

        // 대기 중이던 플레이어가 끊기면 대기열 초기화
        if (waitingPlayer && waitingPlayer.socket.id === socket.id) {
            waitingPlayer = null;
            console.log('[매칭] 대기자 연결 종료로 대기열 초기화');
        }

        // 게임 중이었다면 상대방에게 강제 퇴장 알림
        if (playerRooms[socket.id]) {
            const { roomId } = playerRooms[socket.id];
            socket.to(roomId).emit('forceExit');
            delete roomResetVotes[roomId];
        }

        // 방 정보 정리
        delete playerRooms[socket.id];
    });
});

server.listen(PORT, () => {
    console.log(`Socket.io 서버가 http://localhost:${PORT} 에서 작동 중`);
});
