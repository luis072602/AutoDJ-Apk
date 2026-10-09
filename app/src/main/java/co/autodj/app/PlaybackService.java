package co.autodj.app;

import android.app.Notification;
import android.app.NotificationChannel;
import android.app.NotificationManager;
import android.app.PendingIntent;
import android.app.Service;
import android.content.Context;
import android.content.Intent;
import android.content.pm.ServiceInfo;
import android.graphics.Bitmap;
import android.graphics.BitmapFactory;
import android.os.Build;
import android.os.Handler;
import android.os.IBinder;
import android.os.Looper;
import android.os.PowerManager;
import android.support.v4.media.MediaMetadataCompat;
import android.support.v4.media.session.MediaSessionCompat;
import android.support.v4.media.session.PlaybackStateCompat;
import android.util.Log;

import androidx.core.app.NotificationCompat;
import androidx.core.content.ContextCompat;

import okhttp3.OkHttpClient;
import okhttp3.Request;
import okhttp3.Response;

/**
 * Muestra lo que suena en la barra de notificaciones y en la pantalla de bloqueo, con pausa y siguiente,
 * y mantiene la app viva con la pantalla apagada. El sonido lo sigue produciendo la interfaz (el WebView):
 * este servicio solo informa a Android y le pasa a la interfaz los botones que toca el usuario.
 */
public class PlaybackService extends Service {
    /** Quien recibe «play», «pause», «toggle» o «next» (la actividad, que se lo pasa a la interfaz). */
    interface Controls {
        void command(String c);
    }

    static volatile Controls controls;

    private static final String TAG = "AutoDJ";
    private static final String CHANNEL = "playback";
    private static final int ID = 1;
    private static final String TOGGLE = "co.autodj.app.TOGGLE";
    private static final String NEXT = "co.autodj.app.NEXT";

    private static final class Now {
        String vid = "", title = "AutoDJ", artist = "";
        boolean playing;
        long dur, pos;
        float rate = 1f;
    }

    private static PlaybackService instance;
    private static Now pending;

    /** Se llama desde la interfaz cada vez que cambia la canción o se pausa/reanuda. */
    static void show(Context c, String vid, String title, String artist, boolean playing, long dur, long pos, float rate) {
        Now n = new Now();
        n.vid = vid == null ? "" : vid;
        n.title = title == null || title.isEmpty() ? "AutoDJ" : title;
        n.artist = artist == null ? "" : artist;
        n.playing = playing;
        n.dur = dur;
        n.pos = pos;
        n.rate = rate;
        if (instance != null) {
            instance.update(n);
            return;
        }
        pending = n;
        try {
            ContextCompat.startForegroundService(c, new Intent(c, PlaybackService.class));
        } catch (Exception e) {   // Android no deja arrancarlo si la app no está a la vista
            Log.w(TAG, "No se pudo iniciar la notificación", e);
        }
    }

    /** Ya no suena nada: se quita la notificación. */
    static void hide() {
        pending = null;
        if (instance != null) instance.finish();
    }

    private final Handler main = new Handler(Looper.getMainLooper());
    private final OkHttpClient http = new OkHttpClient();
    private MediaSessionCompat session;
    private PowerManager.WakeLock wake;
    private Now now;
    private Bitmap art;
    private String artVid = "";

    @Override
    public void onCreate() {
        super.onCreate();
        instance = this;

        NotificationChannel ch = new NotificationChannel(CHANNEL, "Reproducción", NotificationManager.IMPORTANCE_LOW);
        ch.setShowBadge(false);
        getSystemService(NotificationManager.class).createNotificationChannel(ch);

        session = new MediaSessionCompat(this, "AutoDJ");
        session.setCallback(new MediaSessionCompat.Callback() {
            @Override
            public void onPlay() {
                send("play");
            }

            @Override
            public void onPause() {
                send("pause");
            }

            @Override
            public void onSkipToNext() {
                send("next");
            }
        });
        session.setActive(true);

        // Mantiene el procesador despierto mientras suena: la mezcla la decide la interfaz con temporizadores
        PowerManager pm = (PowerManager) getSystemService(Context.POWER_SERVICE);
        wake = pm.newWakeLock(PowerManager.PARTIAL_WAKE_LOCK, "AutoDJ:playback");
        wake.setReferenceCounted(false);
    }

    @Override
    public int onStartCommand(Intent intent, int flags, int startId) {
        String action = intent == null ? null : intent.getAction();
        if (TOGGLE.equals(action)) send("toggle");
        else if (NEXT.equals(action)) send("next");

        Now n = pending != null ? pending : now;
        pending = null;
        update(n != null ? n : new Now());   // siempre hay que mostrar la notificación al arrancar
        return START_NOT_STICKY;
    }

    private static void send(String c) {
        Controls x = controls;
        if (x != null) x.command(c);
    }

    private void update(Now n) {
        now = n;

        MediaMetadataCompat.Builder meta = new MediaMetadataCompat.Builder()
                .putString(MediaMetadataCompat.METADATA_KEY_TITLE, n.title)
                .putString(MediaMetadataCompat.METADATA_KEY_ARTIST, n.artist)
                .putLong(MediaMetadataCompat.METADATA_KEY_DURATION, n.dur);
        if (art != null && n.vid.equals(artVid)) meta.putBitmap(MediaMetadataCompat.METADATA_KEY_ALBUM_ART, art);
        session.setMetadata(meta.build());

        session.setPlaybackState(new PlaybackStateCompat.Builder()
                .setActions(PlaybackStateCompat.ACTION_PLAY | PlaybackStateCompat.ACTION_PAUSE
                        | PlaybackStateCompat.ACTION_PLAY_PAUSE | PlaybackStateCompat.ACTION_SKIP_TO_NEXT)
                .setState(n.playing ? PlaybackStateCompat.STATE_PLAYING : PlaybackStateCompat.STATE_PAUSED,
                        n.pos, n.playing ? n.rate : 0f)
                .build());

        Notification notification = build(n);
        if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.Q) {
            startForeground(ID, notification, ServiceInfo.FOREGROUND_SERVICE_TYPE_MEDIA_PLAYBACK);
        } else {
            startForeground(ID, notification);
        }

        if (n.playing) wake.acquire();
        else if (wake.isHeld()) wake.release();

        if (!n.vid.isEmpty() && !n.vid.equals(artVid)) loadArt(n.vid);
    }

    private Notification build(Now n) {
        int immutable = PendingIntent.FLAG_IMMUTABLE | PendingIntent.FLAG_UPDATE_CURRENT;
        PendingIntent open = PendingIntent.getActivity(this, 0,
                new Intent(this, MainActivity.class).setFlags(Intent.FLAG_ACTIVITY_SINGLE_TOP), immutable);
        PendingIntent toggle = PendingIntent.getService(this, 1,
                new Intent(this, PlaybackService.class).setAction(TOGGLE), immutable);
        PendingIntent next = PendingIntent.getService(this, 2,
                new Intent(this, PlaybackService.class).setAction(NEXT), immutable);

        NotificationCompat.Builder b = new NotificationCompat.Builder(this, CHANNEL)
                .setSmallIcon(R.drawable.ic_stat)
                .setContentTitle(n.title)
                .setContentText(n.artist)
                .setContentIntent(open)
                .setOngoing(n.playing)
                .setOnlyAlertOnce(true)
                .setShowWhen(false)
                .setVisibility(NotificationCompat.VISIBILITY_PUBLIC)
                .addAction(n.playing ? android.R.drawable.ic_media_pause : android.R.drawable.ic_media_play,
                        n.playing ? "Pausa" : "Reproducir", toggle)
                .addAction(android.R.drawable.ic_media_next, "Mezclar ya", next)
                .setStyle(new androidx.media.app.NotificationCompat.MediaStyle()
                        .setMediaSession(session.getSessionToken())
                        .setShowActionsInCompactView(0, 1));
        if (art != null && n.vid.equals(artVid)) b.setLargeIcon(art);
        return b.build();
    }

    // Carátula: la miniatura del video
    private void loadArt(final String vid) {
        artVid = vid;
        art = null;
        new Thread(() -> {
            Bitmap bmp = null;
            Request rq = new Request.Builder().url("https://i.ytimg.com/vi/" + vid + "/hqdefault.jpg").build();
            try (Response r = http.newCall(rq).execute()) {
                if (r.isSuccessful() && r.body() != null) bmp = BitmapFactory.decodeStream(r.body().byteStream());
            } catch (Exception ignored) {
            }
            final Bitmap result = bmp;
            main.post(() -> {
                if (result == null || instance != this || now == null || !vid.equals(artVid)) return;
                art = result;
                update(now);
            });
        }).start();
    }

    private void finish() {
        if (wake.isHeld()) wake.release();
        session.setActive(false);
        stopForeground(true);
        stopSelf();
    }

    @Override
    public void onTaskRemoved(Intent rootIntent) {
        finish();   // el usuario cerró la app desde recientes
        super.onTaskRemoved(rootIntent);
    }

    @Override
    public void onDestroy() {
        if (instance == this) instance = null;
        if (wake.isHeld()) wake.release();
        session.release();
        super.onDestroy();
    }

    @Override
    public IBinder onBind(Intent intent) {
        return null;
    }
}
