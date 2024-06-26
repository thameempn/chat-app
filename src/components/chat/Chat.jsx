import { useEffect, useRef, useState } from "react";
import "./chat.css";
import { db } from "../../lib/firebase";
import EmojiPicker from "emoji-picker-react";
import {
  arrayUnion,
  doc,
  getDoc,
  onSnapshot,
  updateDoc,
} from "firebase/firestore";
import { useChatStore } from "../../lib/chatStore";
import upload from "../../lib/upload";
import { useUserStore } from "../../lib/userStore";
import { formatTimestamp } from "../../lib/formatTime";

const Chat = () => {
  const [open, setOpen] = useState(false);
  const [chat, setChat] = useState();
  const [text, setText] = useState("");
  const [loading, setLoading] = useState(false);
  const [img, setImg] = useState({
    file: null,
    url: "",
  });
  const { chatId, user, isCurrentUserBlocked, isReceiverBlocked } =
    useChatStore();
  const endRef = useRef(null);
  const { currentUser } = useUserStore();

  useEffect(() => {
    if (endRef.current) {
      endRef.current.scrollIntoView({ behavior: "smooth" });
    }
  }, [chat?.messages]);

  useEffect(() => {
    if (chatId) {
      const unSub = onSnapshot(doc(db, "chats", chatId), (res) => {
        setChat(res.data());
      });
      return () => {
        unSub();
      };
    }
  }, [chatId]);

  const handleEmojiClick = (e) => {
    setText((prev) => prev + e.emoji);
    setOpen(false);
  };

  const handleImg = (e) => {
    if (e.target.files[0]) {
      setImg({
        file: e.target.files[0],
        url: URL.createObjectURL(e.target.files[0]),
      });
    }
  };

  const handleSend = async () => {
    setOpen(false);
    if (text === "" && !img.file) return;
    setLoading(true);

    let imgUrl = null;

    try {
      if (img.file) {
        imgUrl = await upload(img.file);
      }

      const messageData = {
        senderId: currentUser.id,
        createdAt: new Date(),
        ...(imgUrl && { img: imgUrl }),
        ...(text && { text: text.trim() }),
      };

      await updateDoc(doc(db, "chats", chatId), {
        messages: arrayUnion(messageData),
      });

      const userIDs = [currentUser.id, user.id];

      userIDs.forEach(async (id) => {
        const userChatsRef = doc(db, "userChats", id);
        const userChatsSnapshot = await getDoc(userChatsRef);

        if (userChatsSnapshot.exists()) {
          const userChatsData = userChatsSnapshot.data();

          const chatIndex = userChatsData.chats.findIndex(
            (c) => c.chatId === chatId
          );

          userChatsData.chats[chatIndex].lastMessage = text
            ? text.trim()
            : "Image";
          userChatsData.chats[chatIndex].isSeen =
            id === currentUser.id ? true : false;
          userChatsData.chats[chatIndex].updatedAt = Date.now();

          await updateDoc(userChatsRef, {
            chats: userChatsData.chats,
          });
        }
      });
      setLoading(false);
    } catch (err) {
      console.log(err);
    } finally {
      setImg({
        file: null,
        url: "",
      });

      setText("");
    }
  };

  const removeImage = () => {
    setImg({
      file: null,
      url: "",
    });
  };

  return (
    <div className="chat">
      {chat ? (
        <>
          <div className="top">
            <div className="user">
              <img src={user?.avatar || "./avatar.png"} alt="" />
              <div className="texts">
                <span>{user?.username}</span>
                <p>Lorem Ipsum is simply dummy text</p>
              </div>
            </div>
            <div className="icons">
              <img src="./phone.png" alt="" />
              <img src="./video.png" alt="" />
              <img src="./info.png" alt="" />
            </div>
          </div>
          <div className="center">
            {chat?.messages?.map((message) => (
              <div
                className={
                  message.senderId === currentUser.id
                    ? "message own"
                    : "message"
                }
                key={message?.createdAt.seconds}
              >
                <div className="texts">
                  <p>
                    {message.img && <img src={message.img} alt="" />}
                    {message.text}
                  </p>
                  <span>{formatTimestamp(message.createdAt)}</span>
                </div>
              </div>
            ))}
            <div ref={endRef}></div>
          </div>
          <div className="bottom">
            <div className="icons">
              <label htmlFor="file">
                <img src="./img.png" alt="" />
              </label>
              <input
                type="file"
                id="file"
                style={{ display: "none" }}
                onChange={handleImg}
              />
              <img src="./camera.png" alt="" />
              <img src="./mic.png" alt="" />
            </div>
            <div className="inputContainer">
              <input
                type="text"
                placeholder={
                  isCurrentUserBlocked
                    ? "You cannot send message"
                    : isReceiverBlocked
                    ? "The user is blocked!"
                    : "Type a message..."
                }
                value={text}
                onChange={(e) => setText(e.target.value)}
                disabled={isCurrentUserBlocked || isReceiverBlocked}
              />
              {img.url && (
                <div className="imagePreview">
                  <img src={img.url} alt="Preview" />
                  <button className="removeImage" onClick={removeImage}>
                    x
                  </button>
                </div>
              )}
            </div>
            <div className="emoji" onClick={() => setOpen((prev) => !prev)}>
              <div className="picker">
                <EmojiPicker open={open} onEmojiClick={handleEmojiClick} />
              </div>
              <img src="./emoji.png" alt="" />
            </div>
            <button
              className="sendButton"
              onClick={handleSend}
              disabled={isCurrentUserBlocked || isReceiverBlocked || loading}
            >
              {loading ? "Sending.." : "Send"}
            </button>
          </div>
        </>
      ) : (
        <div className="noChat">
          <span>Select a chat to start a conversation</span>
        </div>
      )}
    </div>
  );
};

export default Chat;
