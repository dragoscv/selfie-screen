package ro.codai.selfiescreen.voice

import android.content.Context
import androidx.room.ColumnInfo
import androidx.room.Dao
import androidx.room.Database
import androidx.room.Entity
import androidx.room.Insert
import androidx.room.OnConflictStrategy
import androidx.room.PrimaryKey
import androidx.room.Query
import androidx.room.Room
import androidx.room.RoomDatabase

/** A viewer remembered across lives. */
@Entity(tableName = "people")
data class Person(
    @PrimaryKey val username: String,
    @ColumnInfo(name = "display_name") val displayName: String,
    @ColumnInfo(name = "first_seen") val firstSeen: Long,
    @ColumnInfo(name = "last_seen") val lastSeen: Long,
    @ColumnInfo(name = "live_count") val liveCount: Int = 1,
    @ColumnInfo(name = "message_count") val messageCount: Int = 0,
    @ColumnInfo(name = "gift_count") val giftCount: Int = 0,
    @ColumnInfo(name = "avatar_url") val avatarUrl: String? = null,
    /** Free-form notes the AI accumulates ("likes Kotlin, from Cluj"). */
    val notes: String = "",
    val blocked: Boolean = false,
)

/** Every spoken/received event, for transcript export + AI context. */
@Entity(tableName = "events")
data class EventRow(
    @PrimaryKey(autoGenerate = true) val id: Long = 0,
    @ColumnInfo(name = "session_id") val sessionId: String,
    val at: Long,
    val username: String,
    val kind: String,
    val text: String,
    @ColumnInfo(name = "was_spoken") val wasSpoken: Boolean = false,
    @ColumnInfo(name = "ai_reply") val aiReply: String? = null,
)

@Dao
interface MemoryDao {
    @Query("SELECT * FROM people WHERE username = :username")
    suspend fun person(username: String): Person?

    @Insert(onConflict = OnConflictStrategy.REPLACE)
    suspend fun upsert(person: Person)

    @Query("SELECT * FROM people ORDER BY gift_count DESC, message_count DESC LIMIT :limit")
    suspend fun topPeople(limit: Int): List<Person>

    @Query("UPDATE people SET blocked = :blocked WHERE username = :username")
    suspend fun setBlocked(username: String, blocked: Boolean)

    @Insert
    suspend fun insertEvent(event: EventRow)

    @Query("SELECT * FROM events WHERE session_id = :sessionId ORDER BY at ASC")
    suspend fun sessionEvents(sessionId: String): List<EventRow>

    @Query("SELECT COUNT(*) FROM events WHERE session_id = :sessionId")
    suspend fun sessionEventCount(sessionId: String): Int

    @Query("SELECT COUNT(DISTINCT username) FROM events WHERE session_id = :sessionId")
    suspend fun sessionUniqueUsers(sessionId: String): Int
}

@Database(entities = [Person::class, EventRow::class], version = 1, exportSchema = false)
abstract class MemoryDb : RoomDatabase() {
    abstract fun dao(): MemoryDao

    companion object {
        @Volatile private var instance: MemoryDb? = null

        fun get(context: Context): MemoryDb = instance ?: synchronized(this) {
            instance ?: Room.databaseBuilder(
                context.applicationContext, MemoryDb::class.java, "selfie-memory.db"
            ).fallbackToDestructiveMigration().build().also { instance = it }
        }
    }
}
