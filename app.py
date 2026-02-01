from flask import Flask, render_template, redirect, url_for, request, jsonify, session
from flask_socketio import SocketIO, emit
from flask_socketio import join_room as socketio_join_room, leave_room as socketio_leave_room
from flask_limiter import Limiter
from flask_limiter.util import get_remote_address
from dotenv import load_dotenv
import random
import string
import html
import json
import os
import logging
import threading
import time
import traceback
from datetime import datetime, timedelta

load_dotenv()
from config import config

logging.basicConfig(
    level=getattr(logging, config.LOG_LEVEL),
    format=config.LOG_FORMAT,
    datefmt=config.LOG_DATE_FORMAT
)
logger = logging.getLogger(__name__)

app = Flask(__name__)
app.secret_key = config.SECRET_KEY

app.config.update(
    SESSION_COOKIE_HTTPONLY=config.SESSION_COOKIE_HTTPONLY,
    SESSION_COOKIE_SAMESITE=config.SESSION_COOKIE_SAMESITE
)

limiter = Limiter(
    app=app,
    key_func=get_remote_address,
    default_limits=config.RATE_LIMIT_DEFAULT
)

socketio = SocketIO(app, cors_allowed_origins=config.CORS_ALLOWED_ORIGINS)

# Charger les mots depuis le fichier JSON
WORDS_FILE = os.path.join(os.path.dirname(__file__), 'words.json')
with open(WORDS_FILE, 'r', encoding='utf-8') as f:
    CARDS = json.load(f)


def cleanup_old_rooms():
    while True:
        time.sleep(config.ROOM_CLEANUP_INTERVAL)
        try:
            now = datetime.now()
            rooms_to_delete = []
            for code, room in list(rooms.items()):
                age = now - room.created_at
                if not room.players or age > timedelta(hours=config.ROOM_MAX_AGE_HOURS):
                    rooms_to_delete.append(code)
            for code in rooms_to_delete:
                del rooms[code]
                logger.info(f"Room {code} supprimee (cleanup)")
            if rooms_to_delete:
                logger.info(f"Cleanup: {len(rooms_to_delete)} salon(s) supprime(s), {len(rooms)} restant(s)")
        except Exception as e:
            logger.error(f"Erreur cleanup: {e}")


cleanup_thread = threading.Thread(target=cleanup_old_rooms, daemon=True)
cleanup_thread.start()


@app.errorhandler(Exception)
def handle_exception(e):
    logger.error(f"Erreur non geree: {e}")
    logger.error(traceback.format_exc())
    if app.debug:
        return jsonify({"error": str(e), "type": type(e).__name__}), 500
    return jsonify({"error": "Une erreur interne est survenue"}), 500


@app.errorhandler(404)
def handle_not_found(e):
    return jsonify({"error": "Ressource non trouvee"}), 404


@app.errorhandler(429)
def handle_rate_limit(e):
    return jsonify({"error": "Trop de requetes, veuillez patienter"}), 429


@app.route("/health")
def health_check():
    return jsonify({
        "status": "healthy",
        "timestamp": datetime.now().isoformat(),
        "rooms_count": len(rooms),
    })


# ==================== Models ====================

def validate_player_name(name):
    if not name:
        return None
    name = name.strip()
    if len(name) > 20 or len(name) < 1:
        return None
    return html.escape(name)


class Room:
    def __init__(self, code, max_players=6):
        self.code = code
        self.max_players = max_players
        self.created_at = datetime.now()
        self.players = {}  # {player_id: player_name}
        self.game = None
        self.started = False
        self.host_player_id = None

    def add_player(self, player_id, player_name):
        if len(self.players) >= self.max_players:
            return False
        if self.started:
            return False
        self.players[player_id] = player_name
        if self.host_player_id is None:
            self.host_player_id = player_id
        return True

    def remove_player(self, player_id):
        if player_id in self.players:
            del self.players[player_id]
            if player_id == self.host_player_id and self.players:
                self.host_player_id = list(self.players.keys())[0]
            return True
        return False

    def start_game(self):
        if len(self.players) < config.MIN_PLAYERS:
            return False
        self.game = Game(list(self.players.keys()), list(self.players.values()))
        self.started = True
        return True

    def get_player_index(self, player_id):
        player_list = list(self.players.keys())
        if player_id in player_list:
            return player_list.index(player_id)
        return None


class Game:
    DRAW_TIME = 40  # 40 secondes par phase de dessin

    def __init__(self, player_ids, player_names):
        self.player_ids = player_ids
        self.player_names = player_names
        self.num_players = len(player_ids)
        self.scores = {pid: 0 for pid in player_ids}
        self.current_picker_index = 0  # joueur1 qui pioche la carte
        self.current_word = None
        self.current_card = None
        self.round = 1
        self.total_rounds = self.num_players
        # Phases: choosing, drawing_player2, drawing_player1, round_end, game_over
        self.phase = "choosing"
        self.guessed = False  # le mot a-t-il été deviné ?
        self.timer_end = None
        self.used_cards = set()
        self.draw_data = []
        self.designated_player_id = None  # joueur2 désigné
        self.current_drawer_id = None  # qui dessine actuellement
        self.point_winner_id = None  # qui a gagné le point ce tour

    @property
    def current_picker_id(self):
        return self.player_ids[self.current_picker_index]

    @property
    def current_picker_name(self):
        return self.player_names[self.current_picker_index]

    def pick_card(self):
        available = [c for c in CARDS if c["carte"] not in self.used_cards]
        if not available:
            self.used_cards.clear()
            available = CARDS
        self.current_card = random.choice(available)
        self.used_cards.add(self.current_card["carte"])
        return self.current_card

    def get_designable_players(self):
        """Retourne les joueurs que le picker peut désigner (tous sauf lui)."""
        return [pid for pid in self.player_ids if pid != self.current_picker_id]

    def choose_word_and_player(self, word_index, designated_id):
        if self.current_card is None:
            return False
        if word_index < 0 or word_index >= len(self.current_card["mots"]):
            return False
        if designated_id not in self.player_ids or designated_id == self.current_picker_id:
            return False
        self.current_word = self.current_card["mots"][word_index]
        self.designated_player_id = designated_id
        self.current_drawer_id = designated_id
        self.phase = "drawing_player2"
        self.timer_end = time.time() + self.DRAW_TIME
        self.guessed = False
        self.point_winner_id = None
        self.draw_data = []
        return True

    def check_guess(self, player_id, guess):
        if self.phase not in ("drawing_player2", "drawing_player1"):
            return False
        # Le dessinateur actuel et le picker ne peuvent pas deviner pendant leur phase
        if player_id == self.current_drawer_id:
            return False
        # Le picker ne peut pas deviner non plus (il connaît le mot)
        if player_id == self.current_picker_id:
            return False
        if guess.strip().lower() == self.current_word.strip().lower():
            self.guessed = True
            # Attribuer 1 point au dessinateur actuel
            if self.phase == "drawing_player2":
                self.point_winner_id = self.designated_player_id
                self.scores[self.designated_player_id] = self.scores.get(self.designated_player_id, 0) + 1
            else:
                self.point_winner_id = self.current_picker_id
                self.scores[self.current_picker_id] = self.scores.get(self.current_picker_id, 0) + 1
            self.end_drawing()
            return True
        return False

    def timer_expired(self):
        """Appelé quand le timer expire. Gère la transition de phase."""
        if self.phase == "drawing_player2":
            # Joueur2 n'a pas réussi, c'est au tour de joueur1
            self.phase = "drawing_player1"
            self.current_drawer_id = self.current_picker_id
            self.timer_end = time.time() + self.DRAW_TIME
            self.draw_data = []
            return "switch_to_player1"
        elif self.phase == "drawing_player1":
            # Joueur1 n'a pas réussi non plus, joueur2 gagne 1 point
            self.point_winner_id = self.designated_player_id
            self.scores[self.designated_player_id] = self.scores.get(self.designated_player_id, 0) + 1
            self.end_drawing()
            return "player1_failed"
        return None

    def end_drawing(self):
        self.phase = "round_end"
        self.timer_end = None

    def next_turn(self):
        self.current_picker_index = (self.current_picker_index + 1) % self.num_players
        if self.current_picker_index == 0:
            self.round += 1
        if self.round > self.total_rounds:
            self.phase = "game_over"
            return False
        self.phase = "choosing"
        self.current_word = None
        self.current_card = None
        self.draw_data = []
        self.designated_player_id = None
        self.current_drawer_id = None
        self.point_winner_id = None
        return True

    def is_time_up(self):
        if self.timer_end and time.time() >= self.timer_end:
            return True
        return False

    def get_remaining_time(self):
        if self.timer_end:
            return max(0, int(self.timer_end - time.time()))
        return 0

    def get_word_hint(self):
        if not self.current_word:
            return ""
        return " ".join("_" if c != " " else " " for c in self.current_word)

    def get_state(self, for_player_id=None):
        player_names_dict = dict(zip(self.player_ids, self.player_names))
        state = {
            "phase": self.phase,
            "round": self.round,
            "total_rounds": self.total_rounds,
            "current_picker_id": self.current_picker_id,
            "current_picker_name": self.current_picker_name,
            "current_drawer_id": self.current_drawer_id,
            "current_drawer_name": player_names_dict.get(self.current_drawer_id, ""),
            "designated_player_id": self.designated_player_id,
            "designated_player_name": player_names_dict.get(self.designated_player_id, ""),
            "scores": {pid: self.scores[pid] for pid in self.player_ids},
            "player_names": player_names_dict,
            "guessed": self.guessed,
            "remaining_time": self.get_remaining_time(),
            "num_players": self.num_players,
            "point_winner_id": self.point_winner_id,
            "point_winner_name": player_names_dict.get(self.point_winner_id, ""),
        }
        # Le picker voit toujours le mot (il l'a choisi)
        if for_player_id == self.current_picker_id:
            state["current_word"] = self.current_word
            if self.phase == "choosing" and self.current_card:
                state["card_choices"] = self.current_card["mots"]
                state["designable_players"] = [
                    {"id": pid, "name": player_names_dict[pid]}
                    for pid in self.get_designable_players()
                ]
        # Le dessinateur voit aussi le mot
        elif for_player_id == self.current_drawer_id:
            state["current_word"] = self.current_word
        else:
            state["word_hint"] = self.get_word_hint()

        # En fin de tour ou fin de partie, tout le monde voit le mot
        if self.phase in ("round_end", "game_over"):
            state["current_word"] = self.current_word

        return state


rooms = {}


def generate_room_code():
    while True:
        code = ''.join(random.choices(string.ascii_uppercase + string.digits, k=4))
        if code not in rooms:
            return code


# ==================== WebSocket State ====================

def emit_game_state(room_code):
    if room_code not in rooms:
        return
    room = rooms[room_code]
    if not room.game:
        return
    # Envoyer un état personnalisé à chaque joueur
    for pid in room.players:
        state = room.game.get_state(for_player_id=pid)
        socketio.emit('game_state_updated', state, room=f"player_{room_code}_{pid}")


def emit_lobby_state(room_code):
    if room_code not in rooms:
        return
    room = rooms[room_code]
    socketio.emit('lobby_updated', {
        "players": [{"id": pid, "name": pname} for pid, pname in room.players.items()],
        "host_id": room.host_player_id,
        "started": room.started,
        "max_players": room.max_players
    }, room=f"lobby_{room_code}")


# ==================== WebSocket Handlers ====================

@socketio.on('join_lobby')
def handle_join_lobby(data):
    room_code = data.get('room')
    socketio_join_room(f"lobby_{room_code}")
    emit_lobby_state(room_code)


@socketio.on('join_game')
def handle_join_game(data):
    room_code = data.get('room')
    player_id = session.get('player_id')
    # Chaque joueur rejoint sa propre room pour recevoir un état personnalisé
    socketio_join_room(f"player_{room_code}_{player_id}")
    # Aussi une room commune pour le dessin
    socketio_join_room(f"game_{room_code}")
    if room_code in rooms and rooms[room_code].game:
        state = rooms[room_code].game.get_state(for_player_id=player_id)
        emit('game_state_updated', state)


@socketio.on('draw')
def handle_draw(data):
    room_code = data.get('room')
    player_id = session.get('player_id')
    if room_code not in rooms:
        return
    room = rooms[room_code]
    if not room.game or room.game.phase not in ("drawing_player2", "drawing_player1"):
        return
    if player_id != room.game.current_drawer_id:
        return
    draw_event = data.get('draw_event')
    if draw_event:
        room.game.draw_data.append(draw_event)
        emit('draw_event', draw_event, room=f"game_{room_code}", include_self=False)


@socketio.on('clear_canvas')
def handle_clear_canvas(data):
    room_code = data.get('room')
    player_id = session.get('player_id')
    if room_code not in rooms:
        return
    room = rooms[room_code]
    if not room.game or player_id != room.game.current_drawer_id:
        return
    room.game.draw_data = []
    emit('clear_canvas', {}, room=f"game_{room_code}", include_self=False)


@socketio.on('guess')
def handle_guess(data):
    room_code = data.get('room')
    player_id = session.get('player_id')
    guess_text = data.get('text', '').strip()
    if not guess_text or room_code not in rooms:
        return
    room = rooms[room_code]
    if not room.game:
        return

    correct = room.game.check_guess(player_id, guess_text)
    player_name = room.players.get(player_id, "???")

    if correct:
        socketio.emit('chat_message', {
            "player_name": player_name,
            "text": guess_text,
            "correct": True
        }, room=f"game_{room_code}")
        emit_game_state(room_code)
    else:
        socketio.emit('chat_message', {
            "player_name": player_name,
            "text": guess_text,
            "correct": False
        }, room=f"game_{room_code}")


@socketio.on('choose_word')
def handle_choose_word(data):
    room_code = data.get('room')
    player_id = session.get('player_id')
    word_index = data.get('index', -1)
    designated_id = data.get('designated_id', '')
    if room_code not in rooms:
        return
    room = rooms[room_code]
    if not room.game or player_id != room.game.current_picker_id:
        return
    if room.game.choose_word_and_player(word_index, designated_id):
        emit_game_state(room_code)


@socketio.on('request_next_turn')
def handle_next_turn(data):
    room_code = data.get('room')
    player_id = session.get('player_id')
    if room_code not in rooms:
        return
    room = rooms[room_code]
    if not room.game:
        return
    if player_id != room.host_player_id:
        return
    if room.game.phase == "round_end":
        room.game.next_turn()
        if room.game.phase == "choosing":
            room.game.pick_card()
        emit_game_state(room_code)


@socketio.on('timer_expired')
def handle_timer_expired(data):
    room_code = data.get('room')
    if room_code not in rooms:
        return
    room = rooms[room_code]
    if not room.game or room.game.phase not in ("drawing_player2", "drawing_player1"):
        return
    if room.game.is_time_up():
        result = room.game.timer_expired()
        if result == "switch_to_player1":
            # Effacer le canvas pour le nouveau dessinateur
            socketio.emit('clear_canvas', {}, room=f"game_{room_code}")
        emit_game_state(room_code)


# WebRTC Voice Chat
@socketio.on('join_voice')
def handle_join_voice(data):
    room_code = data.get('room')
    socketio_join_room(f"voice_{room_code}")
    emit('user_joined', {'player_id': session.get('player_id')}, room=f"voice_{room_code}", include_self=False)


@socketio.on('offer')
def handle_offer(data):
    room_code = data.get('room')
    emit('offer', {
        'offer': data.get('offer'),
        'from': session.get('player_id')
    }, room=f"voice_{room_code}", include_self=False)


@socketio.on('answer')
def handle_answer(data):
    room_code = data.get('room')
    emit('answer', {
        'answer': data.get('answer'),
        'from': session.get('player_id')
    }, room=f"voice_{room_code}", include_self=False)


@socketio.on('ice_candidate')
def handle_ice_candidate(data):
    room_code = data.get('room')
    emit('ice_candidate', {
        'candidate': data.get('candidate'),
        'from': session.get('player_id')
    }, room=f"voice_{room_code}", include_self=False)


@socketio.on('leave_voice')
def handle_leave_voice(data):
    room_code = data.get('room')
    socketio_leave_room(f"voice_{room_code}")
    emit('user_left', {'player_id': session.get('player_id')}, room=f"voice_{room_code}")


# ==================== HTTP Routes ====================

@app.route("/")
def index():
    return render_template("index.html")


@app.route("/create", methods=["GET", "POST"])
@limiter.limit(config.RATE_LIMIT_CREATE)
def create_room():
    if request.method == "POST":
        code = generate_room_code()
        room = Room(code, max_players=config.MAX_PLAYERS)
        rooms[code] = room

        player_id = generate_room_code()
        raw_name = request.form.get("player_name", "")
        player_name = validate_player_name(raw_name) or f"Joueur {len(room.players) + 1}"
        session['player_id'] = player_id
        session['player_name'] = player_name

        room.add_player(player_id, player_name)
        logger.info(f"Salon {code} cree par {player_name}")
        return redirect(url_for("lobby", code=code))

    return render_template("create_room.html")


@app.route("/join", methods=["GET", "POST"])
@limiter.limit(config.RATE_LIMIT_JOIN)
def join_room():
    if request.method == "POST":
        code = request.form.get("code", "").upper()
        raw_name = request.form.get("player_name", "")

        if code not in rooms:
            return render_template("join_room.html", error="Code de partie invalide")

        room = rooms[code]
        player_id = generate_room_code()
        player_name = validate_player_name(raw_name) or f"Joueur {len(room.players) + 1}"
        session['player_id'] = player_id
        session['player_name'] = player_name

        if not room.add_player(player_id, player_name):
            return render_template("join_room.html", error="Impossible de rejoindre cette partie")

        logger.info(f"Joueur {player_name} a rejoint le salon {code}")
        emit_lobby_state(code)
        return redirect(url_for("lobby", code=code))

    return render_template("join_room.html")


@app.route("/lobby/<code>")
def lobby(code):
    if code not in rooms:
        return redirect(url_for("index"))
    room = rooms[code]
    player_id = session.get('player_id')
    if player_id not in room.players:
        return redirect(url_for("join_room"))
    if room.started:
        return redirect(url_for("play_game", code=code))
    return render_template("lobby.html", room=room, player_id=player_id)


@app.route("/lobby/<code>/start", methods=["POST"])
def start_room(code):
    if code not in rooms:
        return "Room not found", 404
    room = rooms[code]
    player_id = session.get('player_id')
    if player_id != room.host_player_id:
        return "Only host can start", 403
    if not room.start_game():
        return "Cannot start game", 400

    # Tirer la première carte
    room.game.pick_card()
    logger.info(f"Partie demarree dans salon {code} avec {len(room.players)} joueurs")
    socketio.emit('game_started', {'room_code': code}, room=f"lobby_{code}")
    return "", 204


@app.route("/game/<code>")
def play_game(code):
    if code not in rooms:
        return redirect(url_for("index"))
    room = rooms[code]
    player_id = session.get('player_id')
    if player_id not in room.players:
        return redirect(url_for("join_room"))
    if not room.started:
        return redirect(url_for("lobby", code=code))
    return render_template("game.html", room=room, player_id=player_id)


if __name__ == "__main__":
    logger.info("=" * 60)
    logger.info("C'EST TROP DUR - PICTIONARY")
    logger.info(f"Acces local: http://localhost:{config.PORT}")
    logger.info("=" * 60)
    logger.info("")
    logger.info("Pour exposer sur internet, utilisez Tailscale Funnel:")
    logger.info(f"  tailscale funnel {config.PORT}")
    logger.info("")

    socketio.run(
        app,
        host=config.HOST,
        port=config.PORT,
        debug=config.DEBUG,
        use_reloader=config.USE_RELOADER,
        allow_unsafe_werkzeug=True
    )
